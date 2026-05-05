import { Effect } from "effect"

import type { DesktopSession, SessionDetectionError } from "../desktop/session.js"
import {
  injectTranscript,
  type InjectionDiagnostics,
  type TextInjectionBackendService,
  type TextInjectionError,
  type TextInjectionResult,
} from "../input/textInjection.js"
import { OpenRouterSttService, type OpenRouterSttError } from "./openrouter.js"

type SttInjectionDiagnostics = InjectionDiagnostics & {
  readonly sttStart: (model: string) => void
  readonly sttComplete: (length: number) => void
  readonly sttFailure: (message: string) => void
}

type TranscribeAndInjectConfig = {
  readonly pcmBytes: Uint8Array
  readonly sampleRate: number
  readonly model: string
  readonly promptTemplate: string
  readonly logPrefix: string
  readonly inject?: boolean
  readonly diagnostics?: SttInjectionDiagnostics | undefined
} & (
  | {
      readonly operation: "transcribe"
      readonly language: string
    }
  | {
      readonly operation: "translate"
      readonly sourceLanguage: string
      readonly targetLanguage: string
    }
)

export const transcribeAndInject = Effect.fn("pie/stt/transcribeAndInject.transcribeAndInject")(
  function* (
    config: TranscribeAndInjectConfig,
  ): Effect.fn.Return<
    TextInjectionResult | undefined,
    OpenRouterSttError | TextInjectionError | SessionDetectionError,
    OpenRouterSttService | DesktopSession | TextInjectionBackendService
  > {
    config.diagnostics?.setState("stt")
    config.diagnostics?.sttStart(config.model)

    const stt = yield* OpenRouterSttService
    const text = yield* (
      config.operation === "transcribe"
        ? stt.transcribe({
            model: config.model,
            pcmBytes: config.pcmBytes,
            sampleRate: config.sampleRate,
            language: config.language,
            promptTemplate: config.promptTemplate,
          })
        : stt.translate({
            model: config.model,
            pcmBytes: config.pcmBytes,
            sampleRate: config.sampleRate,
            sourceLanguage: config.sourceLanguage,
            targetLanguage: config.targetLanguage,
            promptTemplate: config.promptTemplate,
          })
    ).pipe(
      Effect.tapError((cause) =>
        Effect.sync(() => {
          config.diagnostics?.sttFailure(cause.message)
        }),
      ),
    )

    config.diagnostics?.sttComplete(text.length)

    const injectionConfig: {
      text: string
      logPrefix: string
      inject?: boolean
      diagnostics?: SttInjectionDiagnostics | undefined
    } = {
      text,
      logPrefix: config.logPrefix,
      diagnostics: config.diagnostics,
    }

    if (config.inject !== undefined) {
      injectionConfig.inject = config.inject
    }

    return yield* injectTranscript(injectionConfig)
  },
)
