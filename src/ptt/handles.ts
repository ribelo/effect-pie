import { Console, Effect, Fiber, Queue, Stream, type Cause } from "effect"

import { PttKeyboardError } from "../keyboard/monitor.js"
import type { DesktopSession } from "../desktop/session.js"
import type { TextInjectionBackendService } from "../input/textInjection.js"
import type { Niri } from "../niri/service.js"
import { MIN_GAIN_TO_APPLY, normalizePcmForStt, pcmPeak, pcmRms } from "../audio/pcm.js"
import type { SttService } from "../stt/service.js"
import { isSttServiceFailure } from "../stt/streamedDispatch.js"
import { transcribeStreamAndInject } from "../stt/transcribeAndInject.js"
import type { AssistantDiagnostics } from "../assistant/diagnostics.js"
import { writePcmWavFile, type WakewordTrainingError } from "../wakeword/training.js"
import { makePttClipPath } from "../commands/shared.js"
import type { PttCaptureHandle } from "./loop.js"

export const classifyStreamingSttError = (
  failurePrefix: string,
  cause: { readonly _tag?: string; readonly message: string },
): PttKeyboardError => {
  const message = isSttServiceFailure(cause)
    ? `${failurePrefix}: ${cause.message}`
    : `Failed to inject streamed text: ${cause.message}`

  return new PttKeyboardError({ message, cause })
}

export const makeStreamedSttHandle = (config: {
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
}): Effect.Effect<
  PttCaptureHandle,
  PttKeyboardError,
  SttService | Niri | TextInjectionBackendService | DesktopSession
> =>
  Effect.gen(function* () {
    const services = yield* Effect.context<
      SttService | Niri | TextInjectionBackendService | DesktopSession
    >()
    let audioQueue: Queue.Queue<Uint8Array, Cause.Done> | undefined
    let transcriptFiber: Fiber.Fiber<void, PttKeyboardError> | undefined

    const start = Effect.gen(function* () {
      if (audioQueue !== undefined) {
        return audioQueue
      }

      const queue = yield* Queue.unbounded<Uint8Array, Cause.Done>()
      const stream = Stream.fromQueue(queue)
      const transcriptEffect =
        config.operation.kind === "transcribe"
          ? transcribeStreamAndInject({
              operation: "transcribe",
              model: config.operation.model,
              audio: stream,
              sampleRate: config.sampleRate,
              language: config.operation.language,
              promptTemplate: config.operation.promptTemplate,
              logPrefix: config.logPrefix,
              ...(config.inject !== undefined ? { inject: config.inject } : {}),
              ...(config.diagnostics !== undefined ? { diagnostics: config.diagnostics } : {}),
            })
          : transcribeStreamAndInject({
              operation: "translate",
              model: config.operation.model,
              audio: stream,
              sampleRate: config.sampleRate,
              sourceLanguage: config.operation.sourceLanguage,
              targetLanguage: config.operation.targetLanguage,
              promptTemplate: config.operation.promptTemplate,
              logPrefix: config.logPrefix,
              ...(config.inject !== undefined ? { inject: config.inject } : {}),
              ...(config.diagnostics !== undefined ? { diagnostics: config.diagnostics } : {}),
            })

      transcriptFiber = yield* transcriptEffect.pipe(
        Effect.mapError((cause) => classifyStreamingSttError(config.failurePrefix, cause)),
        Effect.asVoid,
        (effect) => Effect.forkChild(effect, { startImmediately: true }),
      )
      audioQueue = queue
      return queue
    })
    const startProvided = start.pipe(Effect.provideContext(services))

    return {
      offer: (chunk) =>
        startProvided.pipe(
          Effect.flatMap((queue) => Queue.offer(queue, chunk)),
          Effect.asVoid,
        ),
      finish: (_clip) =>
        Effect.gen(function* () {
          if (audioQueue === undefined || transcriptFiber === undefined) {
            return
          }
          yield* Queue.end(audioQueue)
          yield* Fiber.join(transcriptFiber)
        }),
      cancel: Effect.gen(function* () {
        if (audioQueue === undefined || transcriptFiber === undefined) {
          return
        }
        yield* Queue.end(audioQueue)
        yield* Fiber.interrupt(transcriptFiber)
      }).pipe(Effect.ignore),
    }
  })

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
          yield* Console.log(
            `[${config.logPrefix}] Normalized clip (rms=${pcmRms(clip.pcmBytes).toFixed(4)} peak=${pcmPeak(clip.pcmBytes).toFixed(4)} gain=${gain.toFixed(2)})`,
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
        const seconds = (clip.durationMs / 1000).toFixed(2)
        yield* Console.log(`[${config.logPrefix}] Saved ${outputPath} (${seconds}s)`)
      }),
    cancel: Effect.void,
  })
