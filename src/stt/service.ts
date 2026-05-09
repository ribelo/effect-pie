import { Context, Data, Effect, Layer, Stream } from "effect"

import { CodexRealtimeSttService, type CodexRealtimeSttError } from "./codexRealtimeService.js"
import { CodexAuthService, type CodexAuthError } from "./codexAuth.js"
import { CODEX_CONVERSATION_TRANSLATION_MODEL } from "./codexRealtime.js"
import { OpenRouterSttService, type OpenRouterSttError } from "./openrouter.js"
import type { SttProvider, SttRuntimeConfig } from "./config.js"

export class SttDispatchError extends Data.TaggedError("SttDispatchError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

export type SttServiceError =
  | SttDispatchError
  | OpenRouterSttError
  | CodexRealtimeSttError
  | CodexAuthError

type TranscribeInput = {
  readonly model: string
  readonly pcmBytes: Uint8Array
  readonly sampleRate: number
  readonly language: string
  readonly promptTemplate: string
  readonly onDelta?: (delta: string) => Effect.Effect<void>
}

type TranscribeStreamInput = Omit<TranscribeInput, "pcmBytes"> & {
  readonly audio: Stream.Stream<Uint8Array>
}

type TranslateInput = {
  readonly model: string
  readonly pcmBytes: Uint8Array
  readonly sampleRate: number
  readonly sourceLanguage: string
  readonly targetLanguage: string
  readonly promptTemplate: string
  readonly onDelta?: (delta: string) => Effect.Effect<void>
}

type TranslateStreamInput = Omit<TranslateInput, "pcmBytes"> & {
  readonly audio: Stream.Stream<Uint8Array>
}

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

export class SttService extends Context.Service<
  SttService,
  {
    readonly provider: SttProvider
    readonly transcribe: (config: TranscribeInput) => Effect.Effect<string, SttServiceError>
    readonly translate: (config: TranslateInput) => Effect.Effect<string, SttServiceError>
    readonly transcribeStream: (
      config: TranscribeStreamInput,
    ) => Effect.Effect<string, SttServiceError>
    readonly translateStream: (
      config: TranslateStreamInput,
    ) => Effect.Effect<string, SttServiceError>
  }
>()("pie/stt/SttService") {
  static readonly layerFromConfig = (
    sttConfig: SttRuntimeConfig,
  ): Layer.Layer<SttService, never, OpenRouterSttService | CodexRealtimeSttService> =>
    Layer.effect(
      SttService,
      Effect.gen(function* () {
        if (sttConfig.provider === "codex-realtime") {
          const codex = yield* CodexRealtimeSttService
          return SttService.of({
            provider: "codex-realtime",
            transcribe: (config) =>
              codex.transcribe({
                model: config.model,
                inputSampleRate: config.sampleRate,
                audio: Stream.succeed(config.pcmBytes),
                language: config.language,
                promptTemplate: config.promptTemplate,
                ...(config.onDelta !== undefined ? { onDelta: config.onDelta } : {}),
              }),
            translate: (config) =>
              codex.translate({
                model: config.model,
                inputSampleRate: config.sampleRate,
                audio: Stream.succeed(config.pcmBytes),
                sourceLanguage: config.sourceLanguage,
                targetLanguage: config.targetLanguage,
                promptTemplate: config.promptTemplate,
                ...(config.onDelta !== undefined ? { onDelta: config.onDelta } : {}),
              }),
            transcribeStream: (config) =>
              codex.transcribe({
                model: config.model,
                inputSampleRate: config.sampleRate,
                audio: config.audio,
                language: config.language,
                promptTemplate: config.promptTemplate,
                ...(config.onDelta !== undefined ? { onDelta: config.onDelta } : {}),
              }),
            translateStream: (config) =>
              config.model === CODEX_CONVERSATION_TRANSLATION_MODEL
                ? config.audio.pipe(
                    Stream.runCollect,
                    Effect.map(concatAudioChunks),
                    Effect.flatMap((pcmBytes) =>
                      codex.translate({
                        model: config.model,
                        inputSampleRate: config.sampleRate,
                        audio: Stream.succeed(pcmBytes),
                        sourceLanguage: config.sourceLanguage,
                        targetLanguage: config.targetLanguage,
                        promptTemplate: config.promptTemplate,
                      }),
                    ),
                  )
                : codex.translate({
                    model: config.model,
                    inputSampleRate: config.sampleRate,
                    audio: config.audio,
                    sourceLanguage: config.sourceLanguage,
                    targetLanguage: config.targetLanguage,
                    promptTemplate: config.promptTemplate,
                    ...(config.onDelta !== undefined ? { onDelta: config.onDelta } : {}),
                  }),
          })
        }

        const openrouter = yield* OpenRouterSttService
        return SttService.of({
          provider: "openrouter",
          transcribe: openrouter.transcribe,
          translate: openrouter.translate,
          transcribeStream: (config) =>
            config.audio.pipe(
              Stream.runCollect,
              Effect.map(concatAudioChunks),
              Effect.flatMap((pcmBytes) => openrouter.transcribe({ ...config, pcmBytes })),
            ),
          translateStream: (config) =>
            config.audio.pipe(
              Stream.runCollect,
              Effect.map(concatAudioChunks),
              Effect.flatMap((pcmBytes) => openrouter.translate({ ...config, pcmBytes })),
            ),
        })
      }),
    )

  static readonly live = (sttConfig: SttRuntimeConfig): Layer.Layer<SttService> =>
    SttService.layerFromConfig(sttConfig).pipe(
      Layer.provide(CodexRealtimeSttService.layer),
      Layer.provide(CodexAuthService.layer),
      Layer.provide(OpenRouterSttService.layer),
    )
}
