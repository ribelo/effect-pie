import { Effect, Ref, type Stream } from "effect"

import type { DesktopSession, SessionDetectionError } from "../desktop/session.js"
import {
  injectTranscript,
  normalizeTextDeltaForInjection,
  TextInjectionBackendService,
  type TextInjectionError,
  type TextInjectionResult,
} from "../input/textInjection.js"
import type { NiriError } from "../niri/errors.js"
import type { Niri } from "../niri/niri.js"
import { promptTemplateWithFocusedWindowContext } from "./focusedWindowPrompt.js"
import { SttService, type SttServiceError } from "./service.js"
import { isSttServiceFailure } from "./streamingError.js"

type TranscribeStreamAndInjectConfig = {
  readonly audio: Stream.Stream<Uint8Array>
  readonly sampleRate: number
  readonly model: string
  readonly promptTemplate: string
  readonly logPrefix: string
  readonly inject?: boolean
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

export const transcribeStreamAndInject = Effect.fn(
  "pie/stt/transcribeAndInject.transcribeStreamAndInject",
)(function* (
  config: TranscribeStreamAndInjectConfig,
): Effect.fn.Return<
  TextInjectionResult | undefined,
  SttServiceError | NiriError | TextInjectionError | SessionDetectionError,
  SttService | Niri | DesktopSession | TextInjectionBackendService
> {
  yield* Effect.annotateCurrentSpan({
    "stt.model": config.model,
    "stt.operation": config.operation,
    ...(config.operation === "transcribe"
      ? { "stt.language": config.language }
      : {
          "stt.sourceLanguage": config.sourceLanguage,
          "stt.targetLanguage": config.targetLanguage,
        }),
  })

  const stt = yield* SttService
  const promptTemplate = yield* promptTemplateWithFocusedWindowContext(config.promptTemplate)
  const sttStartedAt = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
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
          promptTemplate,
          ...(onDelta !== undefined ? { onDelta } : {}),
        })
      : stt.translateStream({
          model: config.model,
          audio: config.audio,
          sampleRate: config.sampleRate,
          sourceLanguage: config.sourceLanguage,
          targetLanguage: config.targetLanguage,
          promptTemplate,
          ...(onDelta !== undefined ? { onDelta } : {}),
        })
  ).pipe(
    Effect.tapError((cause) =>
      Effect.gen(function* () {
        if (isSttServiceFailure(cause)) {
          yield* Effect.logError("STT streaming failed").pipe(
            Effect.annotateLogs({ "stt.error": cause.message }),
          )
        } else {
          yield* Effect.logError("Injection failed during streaming").pipe(
            Effect.annotateLogs({ "injection.error": cause.message }),
          )
        }
      }),
    ),
  )

  const sttFinishedAt = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
  const latencyMs = sttFinishedAt - sttStartedAt

  yield* Effect.annotateCurrentSpan({
    "stt.streamed_chars": text.length,
  })

  yield* Effect.logInfo("STT completed").pipe(
    Effect.annotateLogs({
      "stt.model": config.model,
      "stt.text_length": text.length,
      "stt.latency_ms": latencyMs,
    }),
  )

  const injectionError = yield* Ref.get(injectionErrorRef)
  if (injectionError !== undefined) {
    yield* Effect.logError("Injection failed").pipe(
      Effect.annotateLogs({ "injection.error": injectionError.message }),
    )
    return yield* injectionError
  }

  const streamedChars = yield* Ref.get(streamedCharsRef)
  if (streamedChars > 0) {
    const trimmedText = normalizeTextDeltaForInjection(text).trim()
    yield* Effect.logInfo("Injection completed").pipe(
      Effect.annotateLogs({
        "injection.backend": backend?.backend ?? "unknown",
        "injection.chars": streamedChars,
        "injection.text": trimmedText,
        "injection.log_prefix": config.logPrefix,
      }),
    )
    return undefined
  }

  const injectionConfig: {
    text: string
    logPrefix: string
    inject?: boolean
  } = {
    text,
    logPrefix: config.logPrefix,
  }

  if (config.inject !== undefined) {
    injectionConfig.inject = config.inject
  }

  return yield* injectTranscript(injectionConfig)
})
