import { Context, Effect, Layer, Stream } from "effect"

import { OpenRouterSttService, type OpenRouterSttError } from "./openrouter.js"
import { CodexRealtimeSttService, type CodexRealtimeSttError } from "./codexRealtimeService.js"
import { CodexAuthService, type CodexAuthError } from "./codexAuth.js"
import { codexSttLayer } from "./codexLayer.js"
import { openRouterSttLayer } from "./openRouterLayer.js"
import type { SttRuntimeConfig } from "./config.js"

export type SttServiceError = OpenRouterSttError | CodexRealtimeSttError | CodexAuthError

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

export class SttService extends Context.Service<
  SttService,
  {
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
  static readonly live = (sttConfig: SttRuntimeConfig) =>
    sttConfig.provider === "codex-realtime"
      ? codexSttLayer(sttConfig).pipe(
          Layer.provide(CodexRealtimeSttService.layer),
          Layer.provide(CodexAuthService.layer),
        )
      : openRouterSttLayer(sttConfig).pipe(Layer.provide(OpenRouterSttService.layer))
}
