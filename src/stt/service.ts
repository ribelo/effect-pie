import { Context, Effect, Layer } from "effect"
import type { Stream } from "effect"

import type { OpenRouterSttError } from "./openrouter.js"
import type { CodexRealtimeSttError } from "./codexRealtimeService.js"
import type { CodexAuthError } from "./codexAuth.js"
import type { SttRuntimeConfig } from "./config.js"

export type SttServiceError = OpenRouterSttError | CodexRealtimeSttError | CodexAuthError

type TranscribeStreamInput = {
  readonly model: string
  readonly audio: Stream.Stream<Uint8Array>
  readonly sampleRate: number
  readonly language: string
  readonly promptTemplate: string
  readonly onDelta?: (delta: string) => Effect.Effect<void>
}

type TranslateStreamInput = {
  readonly model: string
  readonly audio: Stream.Stream<Uint8Array>
  readonly sampleRate: number
  readonly sourceLanguage: string
  readonly targetLanguage: string
  readonly promptTemplate: string
  readonly onDelta?: (delta: string) => Effect.Effect<void>
}

export class SttService extends Context.Service<
  SttService,
  {
    readonly transcribeStream: (
      config: TranscribeStreamInput,
    ) => Effect.Effect<string, SttServiceError>
    readonly translateStream: (
      config: TranslateStreamInput,
    ) => Effect.Effect<string, SttServiceError>
  }
>()("pie/stt/SttService") {
  static readonly live = (sttConfig: SttRuntimeConfig): Layer.Layer<SttService> =>
    sttConfig.provider === "codex-realtime"
      ? Layer.unwrap(
          Effect.gen(function* () {
            const { codexSttLayer } = yield* Effect.promise(
              () => import("./codexRealtimeService.js"),
            )
            const { CodexAuthService } = yield* Effect.promise(() => import("./codexAuth.js"))
            return codexSttLayer.pipe(Layer.provide(CodexAuthService.layer))
          }),
        )
      : Layer.unwrap(
          Effect.gen(function* () {
            const { openRouterSttLayer } = yield* Effect.promise(() => import("./openrouter.js"))
            return openRouterSttLayer
          }),
        )
}
