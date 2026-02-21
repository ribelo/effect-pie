import { Generated as OpenAiGenerated, OpenAiClient } from "@effect/ai-openai";
import { Data, Effect, Layer, Redacted, Schema, Stream } from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

const TRANSCRIBE_PROMPT_TEMPLATE =
  'Transcribe the spoken audio in {{language}}. Return application/json with exactly one field: {"transciption":"..."}.';

const TRANSCRIBE_STREAM_PROMPT_TEMPLATE =
  "Transcribe the spoken audio in {{language}}. Return only transcript text.";

const TRANSLATE_PROMPT_TEMPLATE =
  'Transcribe the spoken audio in {{sourceLanguage}} and translate it to {{targetLanguage}}. Return application/json with exactly one field: {"translation":"..."}.';

const TRANSLATE_STREAM_PROMPT_TEMPLATE =
  "Transcribe the spoken audio in {{sourceLanguage}} and translate it to {{targetLanguage}}. Return only translated text.";

const extractStructuredFieldText = (
  value: unknown,
  fields: ReadonlyArray<string>,
): string | undefined => {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const record = value as Record<string, unknown>;

  for (const field of fields) {
    const candidate = record[field];
    if (typeof candidate === "string") {
      return candidate;
    }
  }

  return undefined;
};

export class OpenRouterSttError extends Data.TaggedError("OpenRouterSttError")<{
  readonly message: string;
  readonly cause?: unknown;
  readonly status?: number;
  readonly responseBody?: string;
}> {}

const readEnvString = (
  env: NodeJS.ProcessEnv,
  ...names: ReadonlyArray<string>
): string | undefined => {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value !== undefined && value.length > 0) {
      return value;
    }
  }

  return undefined;
};

export const resolveOpenRouterApiKey = (env: NodeJS.ProcessEnv = process.env): string | undefined =>
  readEnvString(env, "ERG_OPENROUTER_API_KEY", "OPENROUTER_API_KEY");

export const resolveOpenRouterBaseUrl = (env: NodeJS.ProcessEnv = process.env): string =>
  (
    readEnvString(env, "ERG_OPENROUTER_BASE_URL", "OPENROUTER_BASE_URL") ??
    DEFAULT_OPENROUTER_BASE_URL
  ).replace(/\/+$/, "");

const renderTemplate = (template: string, variables: Readonly<Record<string, string>>): string =>
  template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => variables[key] ?? "");

export const encodePcm16MonoWav = (pcmBytes: Uint8Array, sampleRate: number): Uint8Array => {
  const header = new ArrayBuffer(44);
  const view = new DataView(header);

  const writeString = (offset: number, value: string): void => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };

  writeString(0, "RIFF");
  view.setUint32(4, 36 + pcmBytes.length, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, pcmBytes.length, true);

  const wavData = new Uint8Array(44 + pcmBytes.length);
  wavData.set(new Uint8Array(header), 0);
  wavData.set(pcmBytes, 44);
  return wavData;
};

const decodeStructuredField = (config: {
  readonly responseBody: string;
  readonly fields: ReadonlyArray<string>;
  readonly description: string;
}): Effect.Effect<string, OpenRouterSttError> =>
  Effect.gen(function* () {
    const structuredUnknown = yield* Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(
      config.responseBody,
    ).pipe(
      Effect.mapError(
        (cause) =>
          new OpenRouterSttError({
            message: "Failed to parse structured OpenRouter response JSON",
            cause,
            responseBody: config.responseBody,
          }),
      ),
    );

    const extracted = extractStructuredFieldText(structuredUnknown, config.fields);
    if (extracted === undefined) {
      return yield* new OpenRouterSttError({
        message: `OpenRouter response must be a JSON object with one ${config.description} string field`,
        responseBody: config.responseBody,
      });
    }

    const text = extracted.trim();
    if (text.length === 0) {
      return yield* new OpenRouterSttError({
        message: "OpenRouter response did not contain transcript text",
        responseBody: config.responseBody,
      });
    }

    return text;
  });

export const decodeStructuredTransciption = (
  responseBody: string,
): Effect.Effect<string, OpenRouterSttError> =>
  decodeStructuredField({
    responseBody,
    fields: ["transciption", "transcription"],
    description: "`transciption` or `transcription`",
  });

export const decodeStructuredTranslation = (
  responseBody: string,
): Effect.Effect<string, OpenRouterSttError> =>
  decodeStructuredField({
    responseBody,
    fields: ["translation", "translated_text", "transciption", "transcription"],
    description: "`translation`",
  });

const messageFromUnknown = (value: unknown): string | undefined => {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const maybeMessage = (value as { readonly message?: unknown }).message;
  return typeof maybeMessage === "string" ? maybeMessage : undefined;
};

const isDoneSentinelSchemaError = (cause: unknown): boolean => {
  const message = messageFromUnknown(cause);
  if (message === undefined) {
    return false;
  }

  return (
    message.includes('Unexpected identifier "DONE"') || message.includes("Unexpected token 'D'")
  );
};

const extractTextFromMessageContent = (content: unknown): string | undefined => {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return undefined;
  }

  const parts: Array<string> = [];
  for (const item of content) {
    if (typeof item !== "object" || item === null) {
      continue;
    }

    const text = (item as { readonly text?: unknown }).text;
    if (typeof text === "string") {
      parts.push(text);
    }
  }

  if (parts.length === 0) {
    return undefined;
  }

  return parts.join("");
};

const extractRawContentFromChatCompletion = (
  response: typeof OpenAiGenerated.CreateChatCompletion200.Type,
): string | undefined => {
  const choice = response.choices[0];
  if (choice === undefined) {
    return undefined;
  }

  const content = choice.message?.content;
  return extractTextFromMessageContent(content);
};

const makeOpenRouterClientLayer = (apiKey: string, baseUrl: string) => {
  const referer = readEnvString(process.env, "OPENROUTER_HTTP_REFERER", "OR_SITE_URL");
  const title = readEnvString(process.env, "OPENROUTER_X_TITLE", "OR_APP_NAME");

  return OpenAiClient.layer({
    apiKey: Redacted.make(apiKey),
    apiUrl: baseUrl,
    transformClient: (client) =>
      client.pipe(
        HttpClient.mapRequest((request) => {
          let next = request;

          if (referer !== undefined) {
            next = HttpClientRequest.setHeader(next, "HTTP-Referer", referer);
          }

          if (title !== undefined) {
            next = HttpClientRequest.setHeader(next, "X-Title", title);
          }

          return next;
        }),
      ),
  });
};

const runOpenRouterAudioStreaming = (config: {
  readonly model: string;
  readonly prompt: string;
  readonly wavData: Uint8Array;
  readonly structuredDecoder?: (responseBody: string) => Effect.Effect<string, OpenRouterSttError>;
  readonly onDelta?: (delta: string) => Effect.Effect<void, OpenRouterSttError>;
}): Effect.Effect<string, OpenRouterSttError> =>
  Effect.gen(function* () {
    const apiKey = resolveOpenRouterApiKey();
    if (apiKey === undefined) {
      return yield* new OpenRouterSttError({
        message: "Missing OpenRouter API key. Set ERG_OPENROUTER_API_KEY or OPENROUTER_API_KEY.",
      });
    }

    const baseUrl = resolveOpenRouterBaseUrl();

    const payloadBase = {
      model: config.model,
      temperature: 0,
      messages: [
        {
          role: "user" as const,
          content: [
            {
              type: "text" as const,
              text: config.prompt,
            },
            {
              type: "input_audio" as const,
              input_audio: {
                data: Buffer.from(config.wavData).toString("base64"),
                format: "wav" as const,
              },
            },
          ],
        },
      ],
      ...(config.structuredDecoder === undefined
        ? {}
        : {
            response_format: {
              type: "json_object" as const,
            },
          }),
    };

    const openAiLayer = makeOpenRouterClientLayer(apiKey, baseUrl).pipe(
      Layer.provide(FetchHttpClient.layer),
    );

    if (config.onDelta === undefined) {
      const nonStreamingPayload = {
        ...payloadBase,
        stream: false as const,
      } as unknown as typeof OpenAiGenerated.CreateChatCompletionRequestJson.Encoded;

      const nonStreamingEffect = Effect.gen(function* () {
        const client = yield* OpenAiClient.OpenAiClient;

        const response = yield* client.client.createChatCompletion({
          payload: nonStreamingPayload,
        });

        const rawOutput = extractRawContentFromChatCompletion(response)?.trim();
        if (rawOutput === undefined || rawOutput.length === 0) {
          return yield* new OpenRouterSttError({
            message: "OpenRouter response did not contain transcript text",
          });
        }

        if (config.structuredDecoder === undefined) {
          return rawOutput;
        }

        return yield* config.structuredDecoder(rawOutput).pipe(
          Effect.catch(() =>
            Effect.succeed(rawOutput).pipe(
              Effect.filterOrFail(
                (text) => text.length > 0,
                () =>
                  new OpenRouterSttError({
                    message: "OpenRouter response did not contain transcript text",
                    responseBody: rawOutput,
                  }),
              ),
            ),
          ),
        );
      }).pipe(
        Effect.mapError((cause) =>
          cause instanceof OpenRouterSttError
            ? cause
            : new OpenRouterSttError({
                message: "OpenRouter request failed",
                cause,
              }),
        ),
      );

      return yield* nonStreamingEffect.pipe(Effect.provide(openAiLayer));
    }

    const onDelta = config.onDelta;
    if (onDelta === undefined) {
      return yield* new OpenRouterSttError({
        message: "Streaming mode requires onDelta handler",
      });
    }

    const streamingPayload = {
      ...payloadBase,
      stream: true as const,
    } as unknown as typeof OpenAiGenerated.CreateChatCompletionRequestJson.Encoded;

    let streamedContent = "";

    const streamingEffect = Effect.gen(function* () {
      const client = yield* OpenAiClient.OpenAiClient;

      yield* client.client.createChatCompletionSse({ payload: streamingPayload }).pipe(
        Stream.catchIf(
          (cause) => isDoneSentinelSchemaError(cause),
          () => Stream.empty,
        ),
        Stream.runForEach(({ data }) => {
          const choice = data.choices[0];
          if (choice === undefined) {
            return Effect.void;
          }

          const delta = choice.delta.content;
          if (typeof delta !== "string" || delta.length === 0) {
            return Effect.void;
          }

          streamedContent += delta;
          return onDelta(delta);
        }),
      );

      return streamedContent;
    }).pipe(
      Effect.mapError(
        (cause) =>
          new OpenRouterSttError({
            message: "OpenRouter streaming request failed",
            cause,
          }),
      ),
    );

    const rawOutput = yield* streamingEffect.pipe(Effect.provide(openAiLayer));
    const text = rawOutput.trim();

    if (text.length === 0) {
      return yield* new OpenRouterSttError({
        message: "OpenRouter response did not contain transcript text",
      });
    }

    return text;
  });

export const transcribePcmWithOpenRouter = (config: {
  readonly model: string;
  readonly pcmBytes: Uint8Array;
  readonly sampleRate: number;
  readonly language: string;
  readonly onDelta?: (delta: string) => Effect.Effect<void, OpenRouterSttError>;
}): Effect.Effect<string, OpenRouterSttError> =>
  runOpenRouterAudioStreaming({
    model: config.model,
    prompt: renderTemplate(
      config.onDelta === undefined ? TRANSCRIBE_PROMPT_TEMPLATE : TRANSCRIBE_STREAM_PROMPT_TEMPLATE,
      {
        language: config.language,
      },
    ),
    wavData: encodePcm16MonoWav(config.pcmBytes, config.sampleRate),
    ...(config.onDelta === undefined
      ? { structuredDecoder: decodeStructuredTransciption }
      : { onDelta: config.onDelta }),
  });

export const transcribeAndTranslatePcmWithOpenRouter = (config: {
  readonly model: string;
  readonly pcmBytes: Uint8Array;
  readonly sampleRate: number;
  readonly sourceLanguage: string;
  readonly targetLanguage: string;
  readonly onDelta?: (delta: string) => Effect.Effect<void, OpenRouterSttError>;
}): Effect.Effect<string, OpenRouterSttError> =>
  runOpenRouterAudioStreaming({
    model: config.model,
    prompt: renderTemplate(
      config.onDelta === undefined ? TRANSLATE_PROMPT_TEMPLATE : TRANSLATE_STREAM_PROMPT_TEMPLATE,
      {
        sourceLanguage: config.sourceLanguage,
        targetLanguage: config.targetLanguage,
      },
    ),
    wavData: encodePcm16MonoWav(config.pcmBytes, config.sampleRate),
    ...(config.onDelta === undefined
      ? { structuredDecoder: decodeStructuredTranslation }
      : { onDelta: config.onDelta }),
  });
