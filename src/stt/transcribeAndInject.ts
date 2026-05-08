import { Console, Effect, Ref, type Stream } from "effect"

import type { DesktopSession, SessionDetectionError } from "../desktop/session.js"
import {
  injectTranscript,
  normalizeTextDeltaForInjection,
  type InjectionDiagnostics,
  TextInjectionBackendService,
  type TextInjectionError,
  type TextInjectionResult,
} from "../input/textInjection.js"
import { SttService, type SttServiceError } from "./service.js"

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

type TranscribeStreamAndInjectConfig = {
  readonly audio: Stream.Stream<Uint8Array>
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

const isSttServiceFailure = (cause: { readonly _tag?: string }): boolean =>
  cause["_tag"] === "OpenRouterSttError" ||
  cause["_tag"] === "CodexRealtimeSttError" ||
  cause["_tag"] === "CodexAuthError" ||
  cause["_tag"] === "SttDispatchError"

export const transcribeAndInject = Effect.fn("pie/stt/transcribeAndInject.transcribeAndInject")(
  function* (
    config: TranscribeAndInjectConfig,
  ): Effect.fn.Return<
    TextInjectionResult | undefined,
    SttServiceError | TextInjectionError | SessionDetectionError,
    SttService | DesktopSession | TextInjectionBackendService
  > {
    config.diagnostics?.setState("stt")
    config.diagnostics?.sttStart(config.model)

    const stt = yield* SttService
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

export const transcribeStreamAndInject = Effect.fn(
  "pie/stt/transcribeAndInject.transcribeStreamAndInject",
)(function* (
  config: TranscribeStreamAndInjectConfig,
): Effect.fn.Return<
  TextInjectionResult | undefined,
  SttServiceError | TextInjectionError | SessionDetectionError,
  SttService | DesktopSession | TextInjectionBackendService
> {
  config.diagnostics?.setState("stt")
  config.diagnostics?.sttStart(config.model)

  const stt = yield* SttService
  const streamedCharsRef = yield* Ref.make(0)
  const injectionErrorRef = yield* Ref.make<TextInjectionError | undefined>(undefined)
  const backend = config.inject === false ? undefined : yield* TextInjectionBackendService

  const onDelta =
    backend === undefined
      ? undefined
      : (delta: string) =>
          Effect.gen(function* () {
            const normalizedDelta = normalizeTextDeltaForInjection(delta)
            if (normalizedDelta.length === 0) {
              return
            }
            const injectionError = yield* Ref.get(injectionErrorRef)
            if (injectionError !== undefined) {
              return
            }

            const streamedChars = yield* Ref.get(streamedCharsRef)
            if (streamedChars === 0) {
              config.diagnostics?.setState("injection")
              config.diagnostics?.injectionStart(normalizedDelta.length)
            }

            yield* backend.typeText(normalizedDelta).pipe(
              Effect.matchEffect({
                onFailure: (cause) => Ref.set(injectionErrorRef, cause),
                onSuccess: () =>
                  Ref.update(streamedCharsRef, (current) => current + normalizedDelta.length),
              }),
            )
          })

  const text = yield* (
    config.operation === "transcribe"
      ? stt.transcribeStream({
          model: config.model,
          audio: config.audio,
          sampleRate: config.sampleRate,
          language: config.language,
          promptTemplate: config.promptTemplate,
          ...(onDelta !== undefined ? { onDelta } : {}),
        })
      : stt.translateStream({
          model: config.model,
          audio: config.audio,
          sampleRate: config.sampleRate,
          sourceLanguage: config.sourceLanguage,
          targetLanguage: config.targetLanguage,
          promptTemplate: config.promptTemplate,
          ...(onDelta !== undefined ? { onDelta } : {}),
        })
  ).pipe(
    Effect.tapError((cause) =>
      Effect.sync(() => {
        if (isSttServiceFailure(cause)) {
          config.diagnostics?.sttFailure(cause.message)
        } else {
          config.diagnostics?.injectionFailure(cause.message)
        }
      }),
    ),
  )

  config.diagnostics?.sttComplete(text.length)

  const injectionError = yield* Ref.get(injectionErrorRef)
  if (injectionError !== undefined) {
    config.diagnostics?.injectionFailure(injectionError.message)
    return yield* injectionError
  }

  const streamedChars = yield* Ref.get(streamedCharsRef)
  if (streamedChars > 0) {
    const trimmedText = normalizeTextDeltaForInjection(text).trim()
    if (trimmedText.length > 0) {
      yield* Console.log(`[${config.logPrefix}] ${trimmedText}`)
    }
    config.diagnostics?.injectionComplete()
    config.diagnostics?.setState("idle")
    yield* Console.log(
      `[${config.logPrefix}] Typed ${streamedChars} streamed chars with ${backend?.backend ?? "unknown"}`,
    )
    return undefined
  }

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
})
