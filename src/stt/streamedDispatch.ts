import { Effect, Fiber, Queue, Stream, type Cause } from "effect"

import type { DesktopSession, SessionDetectionError } from "../desktop/session.js"
import type { TextInjectionBackendService, TextInjectionError } from "../input/textInjection.js"
import type { NiriError } from "../niri/errors.js"
import type { Niri } from "../niri/niri.js"
import type { SttService, SttServiceError } from "./service.js"
import { transcribeStreamAndInject } from "./transcribeAndInject.js"
import { isSttServiceFailure } from "./streamingError.js"

export type StreamedSttDispatchError =
  | SttServiceError
  | NiriError
  | TextInjectionError
  | SessionDetectionError

export type StreamedSttDispatch = {
  readonly offer: (chunk: Uint8Array) => Effect.Effect<void>
  readonly finish: Effect.Effect<void, StreamedSttDispatchError>
  readonly cancel: Effect.Effect<void>
}

export type StreamedSttDispatchConfig = {
  readonly sampleRate: number
  readonly logPrefix: string
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
}

export const classifyStreamingError = (
  cause: { readonly _tag?: string; readonly message: string },
  failurePrefix: string,
): { readonly kind: "stt" | "injection"; readonly message: string } => {
  if (isSttServiceFailure(cause)) {
    return { kind: "stt", message: `${failurePrefix}: ${cause.message}` }
  }
  return { kind: "injection", message: `Failed to inject streamed text: ${cause.message}` }
}

export const makeStreamedSttDispatch = Effect.fn(
  "pie/stt/streamedDispatch.makeStreamedSttDispatch",
)(function* (
  config: StreamedSttDispatchConfig,
): Effect.fn.Return<
  StreamedSttDispatch,
  never,
  SttService | Niri | TextInjectionBackendService | DesktopSession
> {
  const services = yield* Effect.context<
    SttService | Niri | TextInjectionBackendService | DesktopSession
  >()
  let audioQueue: Queue.Queue<Uint8Array, Cause.Done> | undefined
  let transcriptFiber: Fiber.Fiber<void, StreamedSttDispatchError> | undefined

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
          })

    transcriptFiber = yield* transcriptEffect.pipe(Effect.asVoid, (effect) =>
      Effect.forkChild(effect, { startImmediately: true }),
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
    finish: Effect.gen(function* () {
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
