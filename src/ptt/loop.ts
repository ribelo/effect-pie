import { Console, Duration, Effect, Fiber, Queue, Ref, Stream } from "effect"

import {
  KeyboardMonitorService,
  type KeyboardMonitorKeyEvent,
  PttKeyboardError,
} from "../keyboard/monitor.js"
import type { PulseAudioClient } from "../pulse/client.js"
import type { SampleSpec } from "../pulse/defs.js"
import { createRecordStream } from "../pulse/stream.js"
import { notifyWarning } from "../desktop/notification.js"
import {
  pttCaptureIdle,
  pttCaptureIsAcceptingChunks,
  pttCapturePostRollRemainingMs,
  pttCaptureRelease,
  pttCaptureStart,
  type PttCaptureState,
} from "./capture.js"
import {
  pttDeadInputDetectorInitial,
  pttDeadInputDetectorProcessChunk,
  pttDeadInputDetectorSync,
} from "./deadInput.js"

export type PttTriggerMatch<M extends string> = {
  readonly mode: M
  readonly phase: "press" | "release"
}

export type PttCapturedClip = {
  readonly durationMs: number
  readonly pcmBytes: Uint8Array
}

export type PttCaptureHandle = {
  readonly offer: (chunk: Uint8Array) => Effect.Effect<void, PttKeyboardError>
  readonly finish: (clip: PttCapturedClip) => Effect.Effect<void, PttKeyboardError>
  readonly cancel: Effect.Effect<void>
}

export type PttLoopConfig<M extends string, R> = {
  readonly recognize: (event: KeyboardMonitorKeyEvent) => PttTriggerMatch<M> | undefined
  readonly recordOptions: {
    readonly sampleSpec: SampleSpec
    readonly fragmentSize: number
    readonly sourceName: string | null
  }
  readonly minDurationMs: number
  readonly logPrefix: (mode: M) => string
  readonly onReady: Effect.Effect<void>
  readonly onPress: (mode: M) => Effect.Effect<PttCaptureHandle | "skip", PttKeyboardError, R>
  readonly onRelease?: (mode: M) => Effect.Effect<void>
  readonly onAbort?: Effect.Effect<boolean>
}

const concatChunks = (chunks: ReadonlyArray<Uint8Array>): Uint8Array => {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

export const runPttLoop = Effect.fn("pie/ptt/loop.runPttLoop")(function* <M extends string, R>(
  config: PttLoopConfig<M, R>,
): Effect.fn.Return<never, PttKeyboardError, PulseAudioClient | KeyboardMonitorService | R> {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const loopScope = yield* Effect.scope
      const keyboard = yield* KeyboardMonitorService
      const eventQueue = yield* keyboard.subscribe

      const captureStateRef = yield* Ref.make<PttCaptureState>(pttCaptureIdle)
      const captureChunksRef = yield* Ref.make<ReadonlyArray<Uint8Array>>([])
      const captureStartedAtRef = yield* Ref.make<number | undefined>(undefined)
      const deadInputDetectorRef = yield* Ref.make(pttDeadInputDetectorInitial())
      const currentHandleRef = yield* Ref.make<PttCaptureHandle | undefined>(undefined)
      const currentModeRef = yield* Ref.make<M | undefined>(undefined)
      const audioFiberRef = yield* Ref.make<Fiber.Fiber<void> | undefined>(undefined)

      const stopAudio = Effect.gen(function* () {
        const fiber = yield* Ref.get(audioFiberRef)
        yield* Ref.set(audioFiberRef, undefined)
        if (fiber !== undefined) {
          yield* Fiber.interrupt(fiber).pipe(Effect.ignore)
        }
      })

      const cancelCurrentCapture = Effect.gen(function* () {
        const handle = yield* Ref.get(currentHandleRef)
        yield* Ref.set(currentHandleRef, undefined)
        yield* Ref.set(currentModeRef, undefined)
        if (handle !== undefined) {
          yield* handle.cancel.pipe(Effect.ignore)
        }
        yield* Ref.set(captureChunksRef, [])
        yield* Ref.set(captureStartedAtRef, undefined)
        yield* Ref.set(captureStateRef, pttCaptureIdle)
        yield* Ref.set(deadInputDetectorRef, pttDeadInputDetectorInitial())
      })

      const processChunk = (chunk: Uint8Array) =>
        Effect.gen(function* () {
          const state = yield* Ref.get(captureStateRef)
          const isActive = pttCaptureIsAcceptingChunks(state)

          yield* Ref.update(deadInputDetectorRef, (detector) =>
            pttDeadInputDetectorSync(detector, isActive),
          )

          if (!isActive) {
            return
          }

          const {
            detector: nextDetector,
            warn,
            dead,
            hasInput,
          } = pttDeadInputDetectorProcessChunk(yield* Ref.get(deadInputDetectorRef), chunk)
          yield* Ref.set(deadInputDetectorRef, nextDetector)

          if (warn) {
            const mode = yield* Ref.get(currentModeRef)
            const prefix = mode === undefined ? "ptt" : config.logPrefix(mode)
            yield* Console.log(`[${prefix}] No input detected; microphone probably muted`)
          }

          if (dead) {
            yield* cancelCurrentCapture
            yield* Effect.forkIn(stopAudio, loopScope).pipe(Effect.ignore)
            yield* notifyWarning(
              "pie: no microphone input",
              "No input detected during push-to-talk. Your microphone may be muted.",
            ).pipe(Effect.ignore)
            return
          }

          yield* Ref.update(captureChunksRef, (chunks) => {
            const next = chunks.slice()
            next.push(chunk)
            return next
          })

          if (hasInput) {
            const handle = yield* Ref.get(currentHandleRef)
            if (handle !== undefined) {
              yield* handle.offer(chunk)
            }
          }
        })

      const startAudio = Effect.gen(function* () {
        const existing = yield* Ref.get(audioFiberRef)
        if (existing !== undefined) {
          return
        }

        const fiber = yield* Effect.scoped(
          createRecordStream(config.recordOptions).pipe(
            Stream.runForEach(processChunk),
            Effect.catch((cause: { message: string }) =>
              Effect.gen(function* () {
                const mode = yield* Ref.get(currentModeRef)
                const prefix = mode === undefined ? "ptt" : config.logPrefix(mode)
                yield* Console.log(`[${prefix}] Audio capture failed: ${cause.message}`)
              }),
            ),
          ),
        ).pipe(Effect.forkScoped)
        yield* Ref.set(audioFiberRef, fiber)
      })

      yield* config.onReady

      mainLoop: while (true) {
        const event = yield* Queue.take(eventQueue)

        if (config.onAbort !== undefined) {
          const shouldAbort = yield* config.onAbort
          if (shouldAbort) {
            const state = yield* Ref.get(captureStateRef)
            if (state.tag !== "idle") {
              yield* cancelCurrentCapture
              yield* stopAudio
            }
            continue
          }
        }

        const match = config.recognize(event)
        if (match === undefined) {
          continue
        }

        if (match.phase === "press") {
          const state = yield* Ref.get(captureStateRef)
          const nextState = pttCaptureStart(state, Date.now())
          if (nextState === state) {
            continue
          }

          if (state.tag === "postRoll") {
            yield* Ref.set(captureStateRef, nextState)
            const mode = yield* Ref.get(currentModeRef)
            const prefix = mode === undefined ? "ptt" : config.logPrefix(mode)
            yield* Console.log(`[${prefix}] Post-roll cancelled, continuing capture`)
            continue
          }

          yield* Ref.set(captureChunksRef, [])
          yield* Ref.set(deadInputDetectorRef, pttDeadInputDetectorInitial())
          yield* Ref.set(captureStartedAtRef, Date.now())
          yield* Ref.set(currentModeRef, match.mode)

          const handleResult = yield* config.onPress(match.mode)

          if (handleResult === "skip") {
            yield* Ref.set(captureStartedAtRef, undefined)
            yield* Ref.set(currentModeRef, undefined)
            continue
          }

          yield* Ref.set(currentHandleRef, handleResult)
          yield* Ref.set(captureStateRef, nextState)
          yield* startAudio

          const prefix = config.logPrefix(match.mode)
          yield* Console.log(`[${prefix}] Capturing... release key to stop`)
          continue
        }

        // release
        const state = yield* Ref.get(captureStateRef)
        if (state.tag !== "capturing") {
          continue
        }

        const currentMode = yield* Ref.get(currentModeRef)
        if (currentMode !== match.mode) {
          continue
        }

        yield* Ref.set(captureStateRef, pttCaptureRelease(state, Date.now()))
        if (config.onRelease !== undefined) {
          yield* config.onRelease(match.mode)
        }

        postRollLoop: while (true) {
          const postRollState = yield* Ref.get(captureStateRef)
          const now = Date.now()
          const remaining = pttCapturePostRollRemainingMs(postRollState, now)
          if (remaining <= 0) {
            break postRollLoop
          }

          if (config.onAbort !== undefined) {
            const shouldAbort = yield* config.onAbort
            if (shouldAbort) {
              yield* cancelCurrentCapture
              break postRollLoop
            }
          }

          const deadlineMs = now + remaining
          const timeoutMs = Math.max(0, deadlineMs - Date.now())
          const nextEvent = yield* Queue.take(eventQueue).pipe(
            Effect.timeoutOrElse({
              duration: Duration.millis(timeoutMs),
              orElse: () => Effect.void,
            }),
          )

          if (nextEvent === undefined) {
            break postRollLoop
          }

          const evtMatch = config.recognize(nextEvent)
          if (evtMatch === undefined) {
            continue postRollLoop
          }

          if (evtMatch.phase === "press" && evtMatch.mode === match.mode) {
            yield* Ref.update(captureStateRef, (s) => pttCaptureStart(s, Date.now()))
            const prefix = config.logPrefix(match.mode)
            yield* Console.log(`[${prefix}] Post-roll cancelled, continuing capture`)
            continue mainLoop
          }
        }

        yield* Ref.set(captureStateRef, pttCaptureIdle)
        yield* Ref.set(currentModeRef, undefined)

        const startedAt = yield* Ref.get(captureStartedAtRef)
        yield* Ref.set(captureStartedAtRef, undefined)

        const durationMs = startedAt === undefined ? 0 : Date.now() - startedAt
        const chunks = yield* Ref.get(captureChunksRef)
        yield* Ref.set(captureChunksRef, [])
        const handle = yield* Ref.get(currentHandleRef)
        yield* Ref.set(currentHandleRef, undefined)

        const capturedBytes = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
        const prefix = config.logPrefix(match.mode)
        yield* Console.log(`[${prefix}] Capture stopped (${durationMs}ms, ${capturedBytes} bytes)`)

        if (durationMs < config.minDurationMs) {
          yield* Console.log(
            `[${prefix}] Ignored short clip (${durationMs}ms < ${config.minDurationMs}ms)`,
          )
          if (handle !== undefined) {
            yield* handle.cancel.pipe(Effect.ignore)
          }
          yield* stopAudio
          continue
        }

        const rawPcmBytes = concatChunks(chunks)
        if (rawPcmBytes.length === 0) {
          yield* Console.log(`[${prefix}] Ignored empty clip`)
          if (handle !== undefined) {
            yield* handle.cancel.pipe(Effect.ignore)
          }
          yield* stopAudio
          continue
        }

        if (handle === undefined) {
          yield* stopAudio
          return yield* new PttKeyboardError({
            message: `[${prefix}] PTT capture has no handle`,
          })
        }

        yield* handle.finish({ durationMs, pcmBytes: rawPcmBytes }).pipe(Effect.ensuring(stopAudio))
      }
    }),
  )
})
