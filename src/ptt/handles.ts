import { Effect } from "effect"

import { PttKeyboardError } from "../keyboard/monitor.js"
import type { DesktopSession } from "../desktop/session.js"
import type { TextInjectionBackendService } from "../input/textInjection.js"
import type { Niri } from "../niri/niri.js"
import { MIN_GAIN_TO_APPLY, normalizePcmForStt, pcmPeak, pcmRms } from "../audio/pcm.js"
import type { SttService } from "../stt/service.js"
import { classifyStreamingError, makeStreamedSttDispatch } from "../stt/streamedDispatch.js"
import type { AssistantDiagnostics } from "../assistant/diagnostics.js"
import { writePcmWavFile, type WakewordTrainingError } from "../wakeword/training.js"
import { makePttClipPath } from "../commands/shared.js"
import type { PttCaptureHandle } from "./loop.js"

export const makeStreamedSttHandle = Effect.fn("pie/ptt/handles.makeStreamedSttHandle")(
  function* (config: {
    readonly sampleRate: number
    readonly logPrefix: string
    readonly failurePrefix: string
    readonly inject?: boolean | undefined
    readonly operation:
      | {
          readonly kind: "transcribe"
          readonly model: string
          readonly language: string
          readonly promptTemplate: string
        }
      | {
          readonly kind: "translate"
          readonly model: string
          readonly sourceLanguage: string
          readonly targetLanguage: string
          readonly promptTemplate: string
        }
    readonly diagnostics?: AssistantDiagnostics | undefined
  }): Effect.fn.Return<
    PttCaptureHandle,
    PttKeyboardError,
    SttService | Niri | TextInjectionBackendService | DesktopSession
  > {
    const dispatch = yield* makeStreamedSttDispatch({
      sampleRate: config.sampleRate,
      logPrefix: config.logPrefix,
      inject: config.inject,
      diagnostics: config.diagnostics,
      operation:
        config.operation.kind === "transcribe"
          ? {
              kind: "transcribe",
              model: config.operation.model,
              language: config.operation.language,
              promptTemplate: config.operation.promptTemplate,
            }
          : {
              kind: "translate",
              model: config.operation.model,
              sourceLanguage: config.operation.sourceLanguage,
              targetLanguage: config.operation.targetLanguage,
              promptTemplate: config.operation.promptTemplate,
            },
    })

    return {
      offer: dispatch.offer,
      finish: (_clip) =>
        dispatch.finish.pipe(
          Effect.mapError((cause) => {
            const classified = classifyStreamingError(cause, config.failurePrefix)
            return new PttKeyboardError({ message: classified.message, cause })
          }),
        ),
      cancel: dispatch.cancel,
    }
  },
)

export const makeWavClipHandle = (config: {
  readonly outputDir: string
  readonly sampleRate: number
  readonly logPrefix: string
}): Effect.Effect<PttCaptureHandle> =>
  Effect.succeed({
    offer: () => Effect.void,
    finish: (clip) =>
      Effect.gen(function* () {
        const { normalizedBytes, gain } = normalizePcmForStt(clip.pcmBytes)
        if (gain > MIN_GAIN_TO_APPLY) {
          yield* Effect.logInfo("Normalized clip").pipe(
            Effect.annotateLogs({
              "ptt.log_prefix": config.logPrefix,
              "ptt.rms": pcmRms(clip.pcmBytes),
              "ptt.peak": pcmPeak(clip.pcmBytes),
              "ptt.gain": gain,
            }),
          )
        }
        const outputPath = makePttClipPath(config.outputDir)
        yield* writePcmWavFile(outputPath, normalizedBytes, config.sampleRate).pipe(
          Effect.mapError(
            (cause: WakewordTrainingError) =>
              new PttKeyboardError({
                message: `Failed to write PTT clip at ${outputPath}: ${cause.message}`,
                cause,
              }),
          ),
        )
        const seconds = clip.durationMs / 1000
        yield* Effect.logInfo("Saved PTT clip").pipe(
          Effect.annotateLogs({
            "ptt.log_prefix": config.logPrefix,
            "ptt.output_path": outputPath,
            "ptt.duration_seconds": seconds,
          }),
        )
      }),
    cancel: Effect.void,
  })
