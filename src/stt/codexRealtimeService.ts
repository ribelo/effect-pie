import { type Cause, Data, Duration, Effect, Layer, Queue, Ref, type Scope, Stream } from "effect"

import {
  buildAudioAppend,
  buildAudioCommit,
  buildCodexRealtimeUrl,
  buildConversationTranslationResponseCreate,
  buildConversationTranslationSessionUpdate,
  buildTranscriptionSessionUpdate,
  buildTranslationSessionUpdate,
  CODEX_CONVERSATION_TRANSLATION_MODEL,
  CODEX_REALTIME_SAMPLE_RATE,
  type CodexRealtimeEvent,
  parseCodexRealtimeEvent,
  resampleS16lePcm,
  resolveCodexRealtimeBaseUrl,
  type CodexRealtimeMode,
} from "./codexRealtime.js"
import { CodexAuthService } from "./codexAuth.js"
import { SttService } from "./service.js"
import { isRecord } from "../utils/isRecord.js"

export const concatAudioChunks = (chunks: Iterable<Uint8Array>): Uint8Array => {
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

export class CodexRealtimeSttError extends Data.TaggedError("CodexRealtimeSttError")<{
  readonly message: string
  readonly code?: string | undefined
  readonly cause?: unknown
}> {}

export type CodexRealtimeConnection = {
  readonly send: (payload: string) => Effect.Effect<void, CodexRealtimeSttError>
  readonly close: Effect.Effect<void>
  readonly messages: Stream.Stream<string, CodexRealtimeSttError>
}

type CodexRealtimeAudioConfig = {
  readonly model: string
  readonly inputSampleRate: number
  readonly audio: Stream.Stream<Uint8Array>
  readonly onDelta?: ((delta: string) => Effect.Effect<void>) | undefined
}

export type CodexRealtimeTranscribeConfig = CodexRealtimeAudioConfig & {
  readonly language: string
  readonly promptTemplate: string
}

export type CodexRealtimeTranslateConfig = CodexRealtimeAudioConfig & {
  readonly sourceLanguage: string
  readonly targetLanguage?: string | undefined
  readonly promptTemplate: string
}

const encodeJson = (value: unknown): string => JSON.stringify(value)

const renderTemplate = (template: string, variables: Readonly<Record<string, string>>): string =>
  template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => variables[key] ?? "")

const APPEND_CHUNK_SIZE = 32_000

export const runCodexRealtimeSession = Effect.fn(
  "pie/stt/codexRealtimeService.runCodexRealtimeSession",
)(function* (config: {
  readonly sessionUpdate: unknown
  readonly mode?: CodexRealtimeMode | undefined
  readonly audio: Stream.Stream<Uint8Array>
  readonly inputSampleRate: number
  readonly onDelta?: ((delta: string) => Effect.Effect<void>) | undefined
  readonly translationOutputDrainMillis?: number | undefined
  readonly responseCreate?: unknown
  readonly connection: CodexRealtimeConnection
}): Effect.fn.Return<string, CodexRealtimeSttError> {
  const { connection } = config
  const mode = config.mode ?? "transcription"

  yield* connection.send(encodeJson(config.sessionUpdate))

  const finalRef = yield* Ref.make<string | undefined>(undefined)
  const accumulatedDeltasRef = yield* Ref.make("")
  const errorRef = yield* Ref.make<CodexRealtimeSttError | undefined>(undefined)

  const receive = connection.messages.pipe(
    Stream.mapEffect((payload) =>
      parseCodexRealtimeEvent(payload).pipe(
        Effect.mapError(
          (cause) =>
            new CodexRealtimeSttError({
              message: `Failed to parse Codex realtime event: ${cause.message}`,
              cause,
            }),
        ),
      ),
    ),
    Stream.takeUntilEffect((event: CodexRealtimeEvent) =>
      Effect.gen(function* () {
        if (event.kind === "error") {
          yield* Ref.set(
            errorRef,
            new CodexRealtimeSttError({
              message: `Codex realtime server error: ${event.message}`,
              ...(event.code !== undefined ? { code: event.code } : {}),
            }),
          )
          return true
        }
        if (event.kind === "transcriptDelta") {
          yield* Ref.update(accumulatedDeltasRef, (current) => current + event.delta)
          if (config.onDelta !== undefined) {
            yield* config.onDelta(event.delta)
          }
          return false
        }
        if (event.kind === "transcriptDone") {
          yield* Ref.set(finalRef, event.transcript)
          return true
        }
        if (event.kind === "responseDone") {
          return true
        }
        return false
      }),
    ),
    Stream.runDrain,
  )

  const sendAudioChunks = config.audio.pipe(
    Stream.map((chunk) =>
      resampleS16lePcm(chunk, config.inputSampleRate, CODEX_REALTIME_SAMPLE_RATE),
    ),
    Stream.filter((chunk) => chunk.length > 0),
    Stream.runForEach((chunk) =>
      Effect.gen(function* () {
        for (let offset = 0; offset < chunk.length; offset += APPEND_CHUNK_SIZE) {
          const slice = chunk.subarray(offset, Math.min(offset + APPEND_CHUNK_SIZE, chunk.length))
          yield* connection.send(encodeJson(buildAudioAppend(slice, mode)))
        }
      }),
    ),
  )

  const sendAudio =
    mode === "translation"
      ? sendAudioChunks.pipe(
          Effect.flatMap(() =>
            Effect.sleep(Duration.millis(config.translationOutputDrainMillis ?? 2_000)),
          ),
          Effect.flatMap(() => connection.close),
        )
      : sendAudioChunks.pipe(
          Effect.flatMap(() => connection.send(encodeJson(buildAudioCommit()))),
          Effect.flatMap(() =>
            config.responseCreate === undefined
              ? Effect.void
              : connection.send(encodeJson(config.responseCreate)),
          ),
        )

  yield* Effect.all([receive, sendAudio], { concurrency: 2 })

  const err = yield* Ref.get(errorRef)
  if (err !== undefined) {
    return yield* Effect.fail(err)
  }

  const done = yield* Ref.get(finalRef)
  if (done !== undefined) {
    return done
  }
  const accumulated = (yield* Ref.get(accumulatedDeltasRef)).trim()
  if (accumulated.length === 0) {
    return ""
  }
  return accumulated
})

export type CodexRealtimeSocketFactory = (config: {
  readonly url: string
  readonly accessToken: string
}) => Effect.Effect<CodexRealtimeConnection, CodexRealtimeSttError, Scope.Scope>

export type CodexRealtimeTranscriptionSessionFactory = (config: {
  readonly baseUrl: string
  readonly accessToken: string
  readonly model: string
}) => Effect.Effect<string, CodexRealtimeSttError>

const realtimeRestBaseUrl = (baseUrl: string): string =>
  baseUrl.replace(/^wss:/, "https:").replace(/^ws:/, "http:").replace(/\/+$/, "")

export const createCodexRealtimeTranscriptionSession: CodexRealtimeTranscriptionSessionFactory = (
  config,
) =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(
        `${realtimeRestBaseUrl(config.baseUrl)}/v1/realtime/transcription_sessions`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            input_audio_format: "pcm16",
            input_audio_transcription: { model: config.model },
            turn_detection: null,
          }),
        },
      )

      if (!response.ok) {
        const errorText = await response.text()
        throw new CodexRealtimeSttError({
          message: `Failed to create Codex realtime transcription session: HTTP ${response.status}: ${errorText}`,
        })
      }

      const body: unknown = await response.json()
      const clientSecret = isRecord(body) ? body["client_secret"] : undefined
      const value = isRecord(clientSecret) ? clientSecret["value"] : undefined
      if (typeof value !== "string" || value.length === 0) {
        throw new CodexRealtimeSttError({
          message: "Codex realtime transcription session response missing client_secret.value",
          cause: body,
        })
      }
      return value
    },
    catch: (cause) =>
      cause instanceof CodexRealtimeSttError
        ? cause
        : new CodexRealtimeSttError({
            message: "Failed to create Codex realtime transcription session",
            cause,
          }),
  })

type BunWebSocketOptions = {
  readonly headers?: Readonly<Record<string, string>>
}

type BunWebSocketCtor = new (url: string, options: BunWebSocketOptions) => WebSocket

const createBunWebSocket = (url: string, options: BunWebSocketOptions): WebSocket => {
  // Bun's WebSocket constructor accepts an options object with `headers`, but
  // the TS DOM lib types don't model that overload. Alias through `unknown` to
  // apply the Bun-specific signature at a single, documented boundary.
  const Ctor = WebSocket as unknown as BunWebSocketCtor
  return new Ctor(url, options)
}

const closeWebSocket = (ws: WebSocket): Effect.Effect<void> =>
  Effect.sync(() => {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close()
    }
  })

export const buildCodexRealtimeHeaders = (
  accessToken: string,
): Readonly<Record<string, string>> => ({
  Authorization: `Bearer ${accessToken}`,
})

export const bunWebSocketFactory: CodexRealtimeSocketFactory = (config) =>
  Effect.gen(function* () {
    const messageQueue = yield* Queue.unbounded<string, Cause.Done>()
    const errorRef = yield* Ref.make<CodexRealtimeSttError | undefined>(undefined)

    const ws = yield* Effect.acquireRelease(
      Effect.callback<WebSocket, CodexRealtimeSttError>((resume) => {
        let resolved = false
        const socket = createBunWebSocket(config.url, {
          headers: buildCodexRealtimeHeaders(config.accessToken),
        })

        socket.addEventListener("open", () => {
          if (!resolved) {
            resolved = true
            resume(Effect.succeed(socket))
          }
        })
        socket.addEventListener("error", (event) => {
          const err = new CodexRealtimeSttError({
            message: `Codex realtime WebSocket error (${config.url})`,
            cause: event,
          })
          if (!resolved) {
            resolved = true
            resume(Effect.fail(err))
            return
          }
          Effect.runSync(Ref.set(errorRef, err))
          Effect.runFork(Queue.end(messageQueue))
        })
        socket.addEventListener("message", (event) => {
          const data = typeof event.data === "string" ? event.data : String(event.data)
          Effect.runFork(Queue.offer(messageQueue, data))
        })
        socket.addEventListener("close", () => {
          Effect.runFork(Queue.end(messageQueue))
        })
      }),
      (socket) => closeWebSocket(socket),
    )

    const messages: Stream.Stream<string, CodexRealtimeSttError> = Stream.fromQueue(
      messageQueue,
    ).pipe(
      Stream.concat(
        Stream.unwrap(
          Effect.gen(function* () {
            const err = yield* Ref.get(errorRef)
            return err === undefined
              ? (Stream.empty as Stream.Stream<string, CodexRealtimeSttError>)
              : Stream.fail(err)
          }),
        ),
      ),
    )

    const connection: CodexRealtimeConnection = {
      send: (payload) =>
        Effect.try({
          try: () => ws.send(payload),
          catch: (cause) =>
            new CodexRealtimeSttError({
              message: "Failed to send Codex realtime frame",
              cause,
            }),
        }),
      close: closeWebSocket(ws),
      messages,
    }

    return connection
  })

const makeRealUrl = (config: {
  readonly mode: "transcription" | "translation" | "conversation"
  readonly model: string
}): string =>
  buildCodexRealtimeUrl({
    mode: config.mode,
    model: config.model,
    baseUrl: resolveCodexRealtimeBaseUrl(),
  })

export const transcribeWithCodexRealtime = Effect.fn(
  "pie/stt/codexRealtimeService.transcribeWithCodexRealtime",
)(function* (
  factory: CodexRealtimeSocketFactory,
  accessToken: string,
  config: CodexRealtimeTranscribeConfig,
  createTranscriptionSession: CodexRealtimeTranscriptionSessionFactory = createCodexRealtimeTranscriptionSession,
): Effect.fn.Return<string, CodexRealtimeSttError> {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const baseUrl = resolveCodexRealtimeBaseUrl()
      const transcriptionAccessToken = yield* createTranscriptionSession({
        baseUrl,
        accessToken,
        model: config.model,
      })
      const prompt = renderTemplate(config.promptTemplate, {
        language: config.language,
      })
      const connection = yield* factory({
        url: buildCodexRealtimeUrl({ mode: "transcription", model: config.model, baseUrl }),
        accessToken: transcriptionAccessToken,
      })
      return yield* runCodexRealtimeSession({
        sessionUpdate: buildTranscriptionSessionUpdate({ model: config.model, prompt }),
        mode: "transcription",
        audio: config.audio,
        inputSampleRate: config.inputSampleRate,
        ...(config.onDelta !== undefined ? { onDelta: config.onDelta } : {}),
        connection,
      })
    }),
  )
})

export const translateWithCodexRealtime = Effect.fn(
  "pie/stt/codexRealtimeService.translateWithCodexRealtime",
)(function* (
  factory: CodexRealtimeSocketFactory,
  accessToken: string,
  config: CodexRealtimeTranslateConfig,
): Effect.fn.Return<string, CodexRealtimeSttError> {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const prompt = renderTemplate(config.promptTemplate, {
        source_language: config.sourceLanguage,
        target_language: config.targetLanguage ?? "English",
      })

      if (config.model === CODEX_CONVERSATION_TRANSLATION_MODEL) {
        const connection = yield* factory({
          url: makeRealUrl({ mode: "conversation", model: config.model }),
          accessToken,
        })
        return yield* runCodexRealtimeSession({
          sessionUpdate: buildConversationTranslationSessionUpdate({
            model: config.model,
            prompt,
          }),
          responseCreate: buildConversationTranslationResponseCreate({ prompt }),
          mode: "conversation",
          audio: config.audio,
          inputSampleRate: config.inputSampleRate,
          connection,
        })
      }

      const connection = yield* factory({
        url: makeRealUrl({ mode: "translation", model: config.model }),
        accessToken,
      })
      return yield* runCodexRealtimeSession({
        sessionUpdate: buildTranslationSessionUpdate({
          model: config.model,
          ...(config.targetLanguage !== undefined ? { targetLanguage: config.targetLanguage } : {}),
        }),
        mode: "translation",
        audio: config.audio,
        inputSampleRate: config.inputSampleRate,
        ...(config.onDelta !== undefined ? { onDelta: config.onDelta } : {}),
        connection,
      })
    }),
  )
})

export const makeCodexSttLayer = (
  factory: CodexRealtimeSocketFactory,
): Layer.Layer<SttService, never, CodexAuthService> =>
  Layer.effect(
    SttService,
    Effect.gen(function* () {
      const auth = yield* CodexAuthService
      return SttService.of({
        transcribeStream: (config) =>
          Effect.gen(function* () {
            const token = yield* auth.getAccessToken
            return yield* transcribeWithCodexRealtime(factory, token, {
              model: config.model,
              inputSampleRate: config.sampleRate,
              audio: config.audio,
              language: config.language,
              promptTemplate: config.promptTemplate,
              ...(config.onDelta !== undefined ? { onDelta: config.onDelta } : {}),
            })
          }),
        translateStream: (config) =>
          Effect.gen(function* () {
            const token = yield* auth.getAccessToken
            if (config.model === CODEX_CONVERSATION_TRANSLATION_MODEL) {
              const pcmBytes = yield* config.audio.pipe(
                Stream.runCollect,
                Effect.map(concatAudioChunks),
              )
              return yield* translateWithCodexRealtime(factory, token, {
                model: config.model,
                inputSampleRate: config.sampleRate,
                audio: Stream.succeed(pcmBytes),
                sourceLanguage: config.sourceLanguage,
                targetLanguage: config.targetLanguage,
                promptTemplate: config.promptTemplate,
                onDelta: undefined,
              })
            }
            return yield* translateWithCodexRealtime(factory, token, {
              model: config.model,
              inputSampleRate: config.sampleRate,
              audio: config.audio,
              sourceLanguage: config.sourceLanguage,
              targetLanguage: config.targetLanguage,
              promptTemplate: config.promptTemplate,
              ...(config.onDelta !== undefined ? { onDelta: config.onDelta } : {}),
            })
          }),
      })
    }),
  )

export const codexSttLayer: Layer.Layer<SttService, never, CodexAuthService> =
  makeCodexSttLayer(bunWebSocketFactory)
