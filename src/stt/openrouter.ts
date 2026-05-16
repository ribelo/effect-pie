import { type Generated as OpenAiGenerated, OpenAiClientGenerated } from "@effect/ai-openai"
import { Data, Effect, Layer, Redacted, Schema, Stream } from "effect"
import { SttService } from "./service.js"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import { buildPcmWavHeader } from "../audio/pcm.js"
import { isRecord } from "../utils/isRecord.js"

const extractStructuredFieldText = (
  value: unknown,
  fields: ReadonlyArray<string>,
): string | undefined => {
  if (!isRecord(value)) {
    return undefined
  }

  for (const field of fields) {
    const candidate = value[field]
    if (typeof candidate === "string") {
      return candidate
    }
  }

  return undefined
}

export class OpenRouterSttError extends Data.TaggedError("OpenRouterSttError")<{
  readonly message: string
  readonly cause?: unknown
  readonly status?: number
  readonly responseBody?: string
}> {}

const OPENROUTER_DEFAULT_BASE_URL = "https://openrouter.ai/api/v1"

const readEnvString = (
  env: NodeJS.ProcessEnv,
  ...names: ReadonlyArray<string>
): string | undefined => {
  for (const name of names) {
    const value = env[name]?.trim()
    if (value !== undefined && value.length > 0) {
      return value
    }
  }

  return undefined
}

export const resolveOpenRouterApiKey = (env: NodeJS.ProcessEnv = process.env): string | undefined =>
  readEnvString(env, "ERG_OPENROUTER_API_KEY", "OPENROUTER_API_KEY")

export const resolveOpenRouterBaseUrl = (env: NodeJS.ProcessEnv = process.env): string =>
  readEnvString(env, "ERG_OPENROUTER_BASE_URL", "OPENROUTER_BASE_URL")?.replace(/\/+$/, "") ??
  OPENROUTER_DEFAULT_BASE_URL

export const renderTemplate = (
  template: string,
  variables: Readonly<Record<string, string>>,
): string => template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => variables[key] ?? "")

export const encodePcm16MonoWav = (pcmBytes: Uint8Array, sampleRate: number): Uint8Array => {
  const header = buildPcmWavHeader(pcmBytes.length, sampleRate)

  const wavData = new Uint8Array(44 + pcmBytes.length)
  wavData.set(header, 0)
  wavData.set(pcmBytes, 44)
  return wavData
}

const decodeStructuredField = (config: {
  readonly responseBody: string
  readonly fields: ReadonlyArray<string>
  readonly description: string
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
    )

    const extracted = extractStructuredFieldText(structuredUnknown, config.fields)
    if (extracted === undefined) {
      return yield* Effect.fail(
        new OpenRouterSttError({
          message: `OpenRouter response must be a JSON object with one ${config.description} string field`,
          responseBody: config.responseBody,
        }),
      )
    }

    const text = extracted.trim()
    if (text.length === 0) {
      return yield* Effect.fail(
        new OpenRouterSttError({
          message: "OpenRouter response did not contain transcript text",
          responseBody: config.responseBody,
        }),
      )
    }

    return text
  })

export const decodeStructuredTranscription = (
  responseBody: string,
): Effect.Effect<string, OpenRouterSttError> =>
  decodeStructuredField({
    responseBody,
    fields: ["transcription"],
    description: "`transcription`",
  })

export const decodeStructuredTranslation = (
  responseBody: string,
): Effect.Effect<string, OpenRouterSttError> =>
  decodeStructuredField({
    responseBody,
    fields: ["translation"],
    description: "`translation`",
  })

const messageFromUnknown = (value: unknown): string | undefined => {
  if (typeof value !== "object" || value === null) {
    return undefined
  }

  const maybeMessage = (value as { readonly message?: unknown }).message
  return typeof maybeMessage === "string" ? maybeMessage : undefined
}

const isDoneSentinelSchemaError = (cause: unknown): boolean => {
  const message = messageFromUnknown(cause)
  if (message === undefined) {
    return false
  }

  return (
    message.includes('Unexpected identifier "DONE"') || message.includes("Unexpected token 'D'")
  )
}

const extractTextFromMessageContent = (content: unknown): string | undefined => {
  if (typeof content === "string") {
    return content
  }

  if (!Array.isArray(content)) {
    return undefined
  }

  const parts: Array<string> = []
  for (const item of content) {
    if (!isRecord(item)) {
      continue
    }

    const text = item["text"]
    if (typeof text === "string") {
      parts.push(text)
    }
  }

  if (parts.length === 0) {
    return undefined
  }

  return parts.join("")
}

const extractRawContentFromChatCompletion = (
  response: typeof OpenAiGenerated.CreateChatCompletion200.Type,
): string | undefined => {
  const choice = response.choices[0]
  if (choice === undefined) {
    return undefined
  }

  const content = choice.message?.content
  return extractTextFromMessageContent(content)
}

export const patchSystemFingerprint = (body: unknown): unknown => {
  if (isRecord(body) && body["system_fingerprint"] === null) {
    return { ...body, system_fingerprint: "" }
  }
  return body
}

export const patchServiceTier = (body: unknown): unknown => {
  if (isRecord(body) && "service_tier" in body) {
    const { service_tier: _, ...rest } = body
    return rest
  }
  return body
}

const makeOpenRouterClientLayer = (apiKey: string, baseUrl: string) => {
  const referer = readEnvString(process.env, "OPENROUTER_HTTP_REFERER", "OR_SITE_URL")
  const title = readEnvString(process.env, "OPENROUTER_X_TITLE", "OR_APP_NAME")

  return OpenAiClientGenerated.layer({
    apiKey: Redacted.make(apiKey),
    apiUrl: baseUrl,
    transformClient: (client) =>
      client.pipe(
        HttpClient.mapRequest((request) => {
          let next = request

          if (referer !== undefined) {
            next = HttpClientRequest.setHeader(next, "HTTP-Referer", referer)
          }

          if (title !== undefined) {
            next = HttpClientRequest.setHeader(next, "X-Title", title)
          }

          return next
        }),
        HttpClient.transformResponse((effect) =>
          Effect.gen(function* () {
            const response = yield* effect
            const contentType = response.headers["content-type"] ?? ""
            if (!contentType.includes("application/json")) {
              return response
            }

            const text = yield* response.text
            const parsed: unknown = JSON.parse(text)
            const patched = patchServiceTier(patchSystemFingerprint(parsed))
            const patchedText = JSON.stringify(patched)

            return HttpClientResponse.fromWeb(
              response.request,
              new Response(patchedText, {
                status: response.status,
                headers: { "content-type": "application/json" },
              }),
            )
          }),
        ),
      ),
  }).pipe(Layer.provide(FetchHttpClient.layer))
}

export const TRANSCRIPTION_JSON_SCHEMA = {
  type: "object" as const,
  properties: {
    transcription: { type: "string" as const },
  },
  required: ["transcription"],
  additionalProperties: false,
}

export const TRANSLATION_JSON_SCHEMA = {
  type: "object" as const,
  properties: {
    translation: { type: "string" as const },
  },
  required: ["translation"],
  additionalProperties: false,
}

type RunOpenRouterAudioStreamingConfig = {
  readonly model: string
  readonly prompt: string
  readonly wavData: Uint8Array
  readonly jsonSchema?: {
    readonly name: string
    readonly schema: typeof TRANSCRIPTION_JSON_SCHEMA | typeof TRANSLATION_JSON_SCHEMA
  }
  readonly structuredDecoder?: (responseBody: string) => Effect.Effect<string, OpenRouterSttError>
  readonly onDelta?: (delta: string) => Effect.Effect<void>
}

const runOpenRouterAudioStreamingCore = (
  config: RunOpenRouterAudioStreamingConfig,
): Effect.Effect<string, OpenRouterSttError, OpenAiClientGenerated.OpenAiClientGenerated> =>
  Effect.gen(function* () {
    const client = yield* OpenAiClientGenerated.OpenAiClientGenerated

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
      ...(config.jsonSchema === undefined
        ? {}
        : {
            response_format: {
              type: "json_schema" as const,
              json_schema: {
                name: config.jsonSchema.name,
                strict: true,
                schema: config.jsonSchema.schema,
              },
            },
          }),
    }

    if (config.onDelta === undefined) {
      const nonStreamingPayload = {
        ...payloadBase,
        stream: false as const,
      } as unknown as typeof OpenAiGenerated.CreateChatCompletionRequestJson.Encoded

      const response = yield* client.createChatCompletion({
        payload: nonStreamingPayload,
      })

      const rawOutput = extractRawContentFromChatCompletion(response)?.trim()
      if (rawOutput === undefined || rawOutput.length === 0) {
        return yield* Effect.fail(
          new OpenRouterSttError({
            message: "OpenRouter response did not contain transcript text",
          }),
        )
      }

      if (config.structuredDecoder === undefined) {
        return rawOutput
      }

      return yield* config.structuredDecoder(rawOutput).pipe(
        Effect.mapError(
          () =>
            new OpenRouterSttError({
              message: "OpenRouter structured response did not match expected schema",
              responseBody: rawOutput,
            }),
        ),
      )
    }

    const onDelta = config.onDelta
    const streamingPayload = {
      ...payloadBase,
      stream: true as const,
    } as unknown as typeof OpenAiGenerated.CreateChatCompletionRequestJson.Encoded

    let streamedContent = ""

    yield* client.createChatCompletionSse({ payload: streamingPayload }).pipe(
      Stream.catchIf(
        (cause) => isDoneSentinelSchemaError(cause),
        () => Stream.empty,
      ),
      Stream.runForEach(({ data }) => {
        const choice = data.choices[0]
        if (choice === undefined) {
          return Effect.void
        }

        const delta = choice.delta.content
        if (typeof delta !== "string" || delta.length === 0) {
          return Effect.void
        }

        streamedContent += delta
        return onDelta(delta)
      }),
    )

    const text = streamedContent.trim()

    if (text.length === 0) {
      return yield* Effect.fail(
        new OpenRouterSttError({
          message: "OpenRouter response did not contain transcript text",
        }),
      )
    }

    return text
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof OpenRouterSttError
        ? cause
        : new OpenRouterSttError({
            message: "OpenRouter request failed",
            cause,
          }),
    ),
  )

// Backward-compatible wrapper that resolves env vars and provides Layer internally
const runOpenRouterAudioStreaming = (
  config: RunOpenRouterAudioStreamingConfig,
): Effect.Effect<string, OpenRouterSttError> =>
  Effect.gen(function* () {
    const apiKey = resolveOpenRouterApiKey()
    if (apiKey === undefined) {
      return yield* Effect.fail(
        new OpenRouterSttError({
          message: "Missing OpenRouter API key. Set ERG_OPENROUTER_API_KEY or OPENROUTER_API_KEY.",
        }),
      )
    }

    const baseUrl = resolveOpenRouterBaseUrl()

    const openAiLayer = makeOpenRouterClientLayer(apiKey, baseUrl)
    return yield* runOpenRouterAudioStreamingCore(config).pipe(Effect.provide(openAiLayer))
  })

export const transcribePcmWithOpenRouter = Effect.fn(
  "pie/stt/openrouter.transcribePcmWithOpenRouter",
)(function* (config: {
  readonly model: string
  readonly pcmBytes: Uint8Array
  readonly sampleRate: number
  readonly language: string
  readonly promptTemplate: string
  readonly onDelta?: (delta: string) => Effect.Effect<void>
}): Effect.fn.Return<string, OpenRouterSttError> {
  return yield* runOpenRouterAudioStreaming({
    model: config.model,
    prompt: renderTemplate(config.promptTemplate, {
      language: config.language,
    }),
    wavData: encodePcm16MonoWav(config.pcmBytes, config.sampleRate),
    ...(config.onDelta === undefined
      ? {
          jsonSchema: { name: "transcription_response", schema: TRANSCRIPTION_JSON_SCHEMA },
          structuredDecoder: decodeStructuredTranscription,
        }
      : { onDelta: config.onDelta }),
  })
})

export const transcribeAndTranslatePcmWithOpenRouter = Effect.fn(
  "pie/stt/openrouter.transcribeAndTranslatePcmWithOpenRouter",
)(function* (config: {
  readonly model: string
  readonly pcmBytes: Uint8Array
  readonly sampleRate: number
  readonly sourceLanguage: string
  readonly targetLanguage: string
  readonly promptTemplate: string
  readonly onDelta?: (delta: string) => Effect.Effect<void>
}): Effect.fn.Return<string, OpenRouterSttError> {
  return yield* runOpenRouterAudioStreaming({
    model: config.model,
    prompt: renderTemplate(config.promptTemplate, {
      source_language: config.sourceLanguage,
      target_language: config.targetLanguage,
    }),
    wavData: encodePcm16MonoWav(config.pcmBytes, config.sampleRate),
    ...(config.onDelta === undefined
      ? {
          jsonSchema: { name: "translation_response", schema: TRANSLATION_JSON_SCHEMA },
          structuredDecoder: decodeStructuredTranslation,
        }
      : { onDelta: config.onDelta }),
  })
})

const concatAudioChunks = (chunks: Iterable<Uint8Array>): Uint8Array => {
  let total = 0
  for (const chunk of chunks) {
    total += chunk.length
  }

  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

export const openRouterSttLayer: Layer.Layer<SttService> = Layer.succeed(
  SttService,
  SttService.of({
    transcribeStream: (config) =>
      config.audio.pipe(
        Stream.runCollect,
        Effect.map(concatAudioChunks),
        Effect.flatMap((pcmBytes) =>
          transcribePcmWithOpenRouter({
            model: config.model,
            pcmBytes,
            sampleRate: config.sampleRate,
            language: config.language,
            promptTemplate: config.promptTemplate,
            ...(config.onDelta !== undefined ? { onDelta: config.onDelta } : {}),
          }),
        ),
      ),
    translateStream: (config) =>
      config.audio.pipe(
        Stream.runCollect,
        Effect.map(concatAudioChunks),
        Effect.flatMap((pcmBytes) =>
          transcribeAndTranslatePcmWithOpenRouter({
            model: config.model,
            pcmBytes,
            sampleRate: config.sampleRate,
            sourceLanguage: config.sourceLanguage,
            targetLanguage: config.targetLanguage,
            promptTemplate: config.promptTemplate,
            ...(config.onDelta !== undefined ? { onDelta: config.onDelta } : {}),
          }),
        ),
      ),
  }),
)
