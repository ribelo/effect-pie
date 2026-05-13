import { Console, Duration, Effect, Fiber, Option, Queue, Ref, Stream, type Cause } from "effect"

import type { PulseAudioClient } from "../../pulse/client.js"
import { makePcmRecordOptions } from "../../pulse/defs.js"
import { createRecordStream } from "../../pulse/stream.js"
import { KeyboardMonitorService, type PttKeyboardError } from "../../keyboard/monitor.js"
import type { TextInjectionBackendService } from "../../input/textInjection.js"
import type { DesktopSession } from "../../desktop/session.js"
import type { Niri } from "../../niri/service.js"
import type { AssistantDiagnostics } from "../../assistant/diagnostics.js"
import { notifyWarning } from "../../desktop/notification.js"
import {
  pttCaptureIdle,
  pttCaptureIsAcceptingChunks,
  pttCapturePostRollRemainingMs,
  pttCaptureRelease,
  pttCaptureStart,
  type PttCaptureState,
} from "../../ptt/capture.js"
import {
  pttDeadInputDetectorInitial,
  pttDeadInputDetectorProcessChunk,
  pttDeadInputDetectorSync,
} from "../../ptt/deadInput.js"
import { toPttKeyboardError } from "../ptt.js"
import { concatChunks } from "../shared.js"
import type { CliError } from "../shared.js"
import type { SttService } from "../../stt/service.js"
import { transcribeStreamAndInject } from "../../stt/transcribeAndInject.js"
import type { SttRuntimeConfig } from "../../stt/config.js"
import {
  DEFAULT_ASSISTANT_PTT_TRANSCRIBE_KEYSYM,
  DEFAULT_ASSISTANT_PTT_TRANSLATE_KEYSYM,
  DEFAULT_ASSISTANT_SAMPLE_RATE,
  DEFAULT_ASSISTANT_PTT_FRAGMENT_SIZE,
  DEFAULT_ASSISTANT_MIN_DURATION_MS,
} from "./constants.js"
import {
  tryStartRecording,
  stopRecording,
  type AssistantRecordingMode,
  type AssistantRecordingRuntimeState,
} from "./recordingState.js"

type AssistantPttMode = "transcribe" | "translate"

type AssistantPttStreamingCapture = {
  readonly offer: (chunk: Uint8Array) => Effect.Effect<void>
  readonly finish: Effect.Effect<void, PttKeyboardError>
  readonly cancel: Effect.Effect<void>
}

export const runAssistantPttCombinedLoop = (config: {
  readonly sourceName: string
  readonly sttConfig: SttRuntimeConfig
  readonly pttActiveRef: Ref.Ref<boolean>
  readonly setRecordingMode: (
    mode: AssistantRecordingMode | undefined,
  ) => Effect.Effect<void, CliError>
  readonly recordingCoordinatorRef: Ref.Ref<AssistantRecordingRuntimeState>
  readonly diagnostics?: AssistantDiagnostics | undefined
  readonly pttTranscribeKeysym: Option.Option<number>
  readonly pttTranslateKeysym: Option.Option<number>
  readonly recordingStateRef: Ref.Ref<AssistantRecordingRuntimeState>
}): Effect.Effect<
  never,
  CliError | PttKeyboardError,
  | PulseAudioClient
  | KeyboardMonitorService
  | DesktopSession
  | Niri
  | TextInjectionBackendService
  | SttService
> =>
  Effect.scoped(
    Effect.gen(function* () {
      const transcribeKeysym = Option.getOrElse(
        config.pttTranscribeKeysym,
        () => DEFAULT_ASSISTANT_PTT_TRANSCRIBE_KEYSYM,
      )
      const translateKeysym = Option.getOrElse(
        config.pttTranslateKeysym,
        () => DEFAULT_ASSISTANT_PTT_TRANSLATE_KEYSYM,
      )

      const sourceLanguage = config.sttConfig.translationSourceLanguage
      const targetLanguage = config.sttConfig.translationTargetLanguage

      const makeStreamingCapture = (
        mode: AssistantPttMode,
      ): Effect.Effect<
        AssistantPttStreamingCapture,
        PttKeyboardError,
        SttService | Niri | DesktopSession | TextInjectionBackendService
      > =>
        Effect.gen(function* () {
          const services = yield* Effect.context<
            SttService | Niri | DesktopSession | TextInjectionBackendService
          >()
          let audioQueue: Queue.Queue<Uint8Array, Cause.Done> | undefined
          let fiber: Fiber.Fiber<void, PttKeyboardError> | undefined

          const start = Effect.gen(function* () {
            if (audioQueue !== undefined) {
              return audioQueue
            }

            const queue = yield* Queue.unbounded<Uint8Array, Cause.Done>()
            const audio = Stream.fromQueue(queue)
            const transcript =
              mode === "transcribe"
                ? transcribeStreamAndInject({
                    operation: "transcribe",
                    model: config.sttConfig.transcriptionModel,
                    audio,
                    sampleRate: DEFAULT_ASSISTANT_SAMPLE_RATE,
                    language: config.sttConfig.transcriptionLanguage,
                    promptTemplate: config.sttConfig.transcriptionPrompt,
                    logPrefix: "assistant-ptt-transcribe",
                    diagnostics: config.diagnostics,
                  })
                : transcribeStreamAndInject({
                    operation: "translate",
                    model: config.sttConfig.translationModel,
                    audio,
                    sampleRate: DEFAULT_ASSISTANT_SAMPLE_RATE,
                    sourceLanguage,
                    targetLanguage,
                    promptTemplate: config.sttConfig.translationPrompt,
                    logPrefix: "assistant-ptt-translate",
                    diagnostics: config.diagnostics,
                  })

            fiber = yield* transcript.pipe(
              Effect.mapError((cause) => {
                const message =
                  cause["_tag"] === "OpenRouterSttError" ||
                  cause["_tag"] === "CodexRealtimeSttError" ||
                  cause["_tag"] === "CodexAuthError" ||
                  cause["_tag"] === "SttDispatchError" ||
                  (cause["_tag"]?.startsWith("Niri") ?? false)
                    ? `${mode === "transcribe" ? "PTT transcription" : "PTT translation"} failed: ${cause.message}`
                    : `Failed to type streamed ${mode} text: ${cause.message}`

                return toPttKeyboardError(message, cause)
              }),
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
            finish: Effect.gen(function* () {
              if (audioQueue === undefined || fiber === undefined) {
                return
              }
              yield* Queue.end(audioQueue)
              yield* Fiber.join(fiber)
            }),
            cancel: Effect.gen(function* () {
              if (audioQueue === undefined || fiber === undefined) {
                return
              }
              yield* Queue.end(audioQueue)
              yield* Fiber.interrupt(fiber)
            }).pipe(Effect.ignore),
          }
        })

      yield* Console.log(
        `[assistant] PTT transcribe armed on keysym=${transcribeKeysym} source=${config.sourceName}`,
      )
      yield* Console.log(
        `[assistant] PTT translate armed on keysym=${translateKeysym} source=${config.sourceName} (${sourceLanguage} -> ${targetLanguage})`,
      )
      yield* Console.log(`PTT transcribe ready (keysym=${transcribeKeysym}). Hold key to dictate.`)
      yield* Console.log(
        `PTT translate ready (keysym=${translateKeysym}, ${sourceLanguage} -> ${targetLanguage}). Hold key to dictate.`,
      )

      const keyboard = yield* KeyboardMonitorService
      const eventQueue = yield* keyboard.subscribe

      const captureStateRef = yield* Ref.make<PttCaptureState>(pttCaptureIdle)
      const captureModeRef = yield* Ref.make<AssistantPttMode | undefined>(undefined)
      const captureChunksRef = yield* Ref.make<ReadonlyArray<Uint8Array>>([])
      const captureStartedAtRef = yield* Ref.make<number | undefined>(undefined)
      const streamingCaptureRef = yield* Ref.make<AssistantPttStreamingCapture | undefined>(
        undefined,
      )
      const captureAudioFiberRef = yield* Ref.make<Fiber.Fiber<void> | undefined>(undefined)

      const stopCaptureAudio = Effect.gen(function* () {
        const fiber = yield* Ref.get(captureAudioFiberRef)
        yield* Ref.set(captureAudioFiberRef, undefined)
        if (fiber !== undefined) {
          yield* Fiber.interrupt(fiber).pipe(Effect.ignore)
        }
      })

      yield* Effect.addFinalizer(() =>
        Effect.all(
          [
            Ref.set(config.pttActiveRef, false),
            stopCaptureAudio,
            Ref.get(streamingCaptureRef).pipe(
              Effect.flatMap((streamingCapture) =>
                streamingCapture === undefined ? Effect.void : streamingCapture.cancel,
              ),
              Effect.ignore,
            ),
            Effect.gen(function* () {
              const runtime = yield* Ref.get(config.recordingCoordinatorRef)
              if (runtime.mode !== undefined) {
                yield* stopRecording({
                  ref: config.recordingCoordinatorRef,
                  mode: runtime.mode,
                }).pipe(Effect.orDie)
              }
            }),
          ],
          {
            discard: true,
          },
        ),
      )

      const deadInputDetectorRef = yield* Ref.make(pttDeadInputDetectorInitial())

      const processCaptureChunk = (chunk: Uint8Array) =>
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
            yield* Console.log("[assistant-ptt] No input detected; microphone probably muted")
            yield* notifyWarning(
              "pie: no microphone input",
              "No input detected during push-to-talk. Your microphone may be muted.",
            )
          }

          if (dead) {
            const streamingCapture = yield* Ref.get(streamingCaptureRef)
            yield* Ref.set(streamingCaptureRef, undefined)
            if (streamingCapture !== undefined) {
              yield* streamingCapture.cancel
            }
            yield* Ref.set(captureChunksRef, [])
            yield* Ref.set(captureStartedAtRef, undefined)
            yield* Ref.set(captureModeRef, undefined)
            yield* Ref.set(captureStateRef, pttCaptureIdle)
            yield* Ref.set(captureAudioFiberRef, undefined)
            yield* Ref.set(deadInputDetectorRef, pttDeadInputDetectorInitial())
            yield* Ref.set(config.pttActiveRef, false)
            const runtime = yield* Ref.get(config.recordingCoordinatorRef)
            if (runtime.mode === "ptt-transcribe" || runtime.mode === "ptt-translate") {
              yield* stopRecording({
                ref: config.recordingCoordinatorRef,
                mode: runtime.mode,
              }).pipe(Effect.orDie)
            }
            config.diagnostics?.setState("idle")
            return
          }

          yield* Ref.update(captureChunksRef, (chunks) => {
            const next = chunks.slice()
            next.push(chunk)
            return next
          })

          if (hasInput) {
            const streamingCapture = yield* Ref.get(streamingCaptureRef)
            if (streamingCapture !== undefined) {
              yield* streamingCapture.offer(chunk)
            }
          }
        })

      const startCaptureAudio = Effect.gen(function* () {
        const existing = yield* Ref.get(captureAudioFiberRef)
        if (existing !== undefined) {
          return
        }

        const fiber = yield* createRecordStream(
          makePcmRecordOptions({
            rate: DEFAULT_ASSISTANT_SAMPLE_RATE,
            fragmentSize: DEFAULT_ASSISTANT_PTT_FRAGMENT_SIZE,
            sourceName: config.sourceName,
          }),
        ).pipe(
          Stream.takeUntilEffect(() =>
            Ref.get(captureStateRef).pipe(Effect.map((state) => state.tag === "idle")),
          ),
          Stream.runForEach(processCaptureChunk),
          Effect.catch((cause) =>
            Console.log(`[assistant-ptt] Audio capture failed: ${cause.message}`),
          ),
          Effect.forkScoped,
        )
        yield* Ref.set(captureAudioFiberRef, fiber)
      })

      mainLoop: while (true) {
        const event = yield* Queue.take(eventQueue)

        const daemonState = yield* Ref.get(config.recordingStateRef)
        if (!daemonState.enabled) {
          const state = yield* Ref.get(captureStateRef)
          if (state.tag !== "idle") {
            const streamingCapture = yield* Ref.get(streamingCaptureRef)
            yield* Ref.set(streamingCaptureRef, undefined)
            if (streamingCapture !== undefined) {
              yield* streamingCapture.cancel
            }
            yield* stopCaptureAudio
            yield* Ref.set(captureChunksRef, [])
            yield* Ref.set(captureStartedAtRef, undefined)
            yield* Ref.set(captureModeRef, undefined)
            yield* Ref.set(captureStateRef, pttCaptureIdle)
            yield* Ref.set(deadInputDetectorRef, pttDeadInputDetectorInitial())
            yield* Ref.set(config.pttActiveRef, false)
            const runtime = yield* Ref.get(config.recordingCoordinatorRef)
            if (runtime.mode === "ptt-transcribe" || runtime.mode === "ptt-translate") {
              yield* stopRecording({
                ref: config.recordingCoordinatorRef,
                mode: runtime.mode,
              }).pipe(Effect.orDie)
            }
            config.diagnostics?.setState("idle")
          }
          continue
        }

        const mode: AssistantPttMode | undefined =
          event.keysym === transcribeKeysym
            ? "transcribe"
            : event.keysym === translateKeysym
              ? "translate"
              : undefined

        if (mode === undefined) {
          continue
        }

        const modePrefix =
          mode === "transcribe" ? "assistant-ptt-transcribe" : "assistant-ptt-translate"
        const recordingMode: AssistantRecordingMode =
          mode === "transcribe" ? "ptt-transcribe" : "ptt-translate"

        if (!event.released) {
          const state = yield* Ref.get(captureStateRef)
          const nextState = pttCaptureStart(state, Date.now())
          if (nextState === state) {
            continue
          }

          if (state.tag === "postRoll") {
            yield* Ref.set(captureStateRef, nextState)
            yield* Console.log(`[${modePrefix}] Post-roll cancelled, continuing capture`)
            continue
          }

          yield* Ref.set(captureChunksRef, [])
          yield* Ref.set(deadInputDetectorRef, pttDeadInputDetectorInitial())
          yield* Ref.set(captureStartedAtRef, Date.now())
          yield* Ref.set(captureModeRef, mode)
          const streamingCapture = yield* makeStreamingCapture(mode)
          yield* Ref.set(streamingCaptureRef, streamingCapture)
          yield* Ref.set(captureStateRef, nextState)
          yield* startCaptureAudio
          const result = yield* tryStartRecording({
            ref: config.recordingCoordinatorRef,
            mode: recordingMode,
          })
          if (result["_tag"] === "Busy") {
            yield* Console.log(`[${modePrefix}] Ignored: ${result.activeMode} is active`)
            yield* Ref.set(captureChunksRef, [])
            yield* Ref.set(captureStartedAtRef, undefined)
            yield* Ref.set(captureModeRef, undefined)
            yield* Ref.set(captureStateRef, pttCaptureIdle)
            const streamingCapture = yield* Ref.get(streamingCaptureRef)
            yield* Ref.set(streamingCaptureRef, undefined)
            if (streamingCapture !== undefined) {
              yield* streamingCapture.cancel
            }
            yield* stopCaptureAudio
            continue
          }
          if (result["_tag"] === "Disabled") {
            yield* Console.log(`[${modePrefix}] Ignored: PIE is disabled`)
            yield* Ref.set(captureChunksRef, [])
            yield* Ref.set(captureStartedAtRef, undefined)
            yield* Ref.set(captureModeRef, undefined)
            yield* Ref.set(captureStateRef, pttCaptureIdle)
            const streamingCapture = yield* Ref.get(streamingCaptureRef)
            yield* Ref.set(streamingCaptureRef, undefined)
            if (streamingCapture !== undefined) {
              yield* streamingCapture.cancel
            }
            yield* stopCaptureAudio
            continue
          }
          yield* Ref.set(config.pttActiveRef, true)
          config.diagnostics?.pttHold(mode)
          config.diagnostics?.setState(mode === "transcribe" ? "ptt-transcribe" : "ptt-translate")
          yield* Console.log(`[${modePrefix}] Capturing... release key to stop`)
          continue
        }

        const state = yield* Ref.get(captureStateRef)
        if (state.tag !== "capturing") {
          continue
        }

        const activeMode = yield* Ref.get(captureModeRef)
        if (activeMode !== mode) {
          continue
        }

        yield* Ref.set(captureStateRef, pttCaptureRelease(state, Date.now()))
        config.diagnostics?.pttRelease()

        postRollLoop: while (true) {
          const postRollState = yield* Ref.get(captureStateRef)
          const now = Date.now()
          const remaining = pttCapturePostRollRemainingMs(postRollState, now)
          if (remaining <= 0) {
            break postRollLoop
          }

          const deadlineMs = now + remaining
          const nextEvent = yield* Effect.sync(() => {
            const timeoutMs = Math.max(0, deadlineMs - Date.now())
            return Queue.take(eventQueue).pipe(
              Effect.timeoutOrElse({
                duration: Duration.millis(timeoutMs),
                orElse: () => Effect.void,
              }),
            )
          }).pipe(Effect.flatten)

          if (nextEvent === undefined) {
            break postRollLoop
          }

          const evt = nextEvent
          const evtMode: AssistantPttMode | undefined =
            evt.keysym === transcribeKeysym
              ? "transcribe"
              : evt.keysym === translateKeysym
                ? "translate"
                : undefined

          if (evtMode === undefined) {
            continue postRollLoop
          }

          if (!evt.released && evtMode === mode) {
            yield* Ref.update(captureStateRef, (s) => pttCaptureStart(s, Date.now()))
            yield* Console.log(`[${modePrefix}] Post-roll cancelled, continuing capture`)
            continue mainLoop
          }
        }

        yield* Ref.set(captureStateRef, pttCaptureIdle)
        yield* stopCaptureAudio
        yield* Ref.set(captureModeRef, undefined)
        const pttRuntime = yield* Ref.get(config.recordingCoordinatorRef)
        if (pttRuntime.mode === "ptt-transcribe" || pttRuntime.mode === "ptt-translate") {
          yield* stopRecording({
            ref: config.recordingCoordinatorRef,
            mode: pttRuntime.mode,
          }).pipe(Effect.orDie)
        }

        const startedAt = yield* Ref.get(captureStartedAtRef)
        yield* Ref.set(captureStartedAtRef, undefined)

        yield* Effect.gen(function* () {
          const durationMs = startedAt === undefined ? 0 : Date.now() - startedAt
          const chunks = yield* Ref.get(captureChunksRef)
          yield* Ref.set(captureChunksRef, [])
          const streamingCapture = yield* Ref.get(streamingCaptureRef)
          yield* Ref.set(streamingCaptureRef, undefined)

          const capturedBytes = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
          config.diagnostics?.pttFinalize(durationMs)
          yield* Console.log(
            `[${modePrefix}] Capture stopped (${durationMs}ms, ${capturedBytes} bytes)`,
          )

          if (durationMs < DEFAULT_ASSISTANT_MIN_DURATION_MS) {
            yield* Console.log(
              `[${modePrefix}] Ignored short clip (${durationMs}ms < ${DEFAULT_ASSISTANT_MIN_DURATION_MS}ms)`,
            )
            if (streamingCapture !== undefined) {
              yield* streamingCapture.cancel
            }
            config.diagnostics?.setState("idle")
            return
          }

          const rawPcmBytes = concatChunks(chunks)
          if (rawPcmBytes.length === 0) {
            yield* Console.log(`[${modePrefix}] Ignored empty clip`)
            if (streamingCapture !== undefined) {
              yield* streamingCapture.cancel
            }
            config.diagnostics?.setState("idle")
            return
          }

          if (streamingCapture === undefined) {
            return yield* toPttKeyboardError(
              `[${modePrefix}] Missing streaming STT capture`,
              undefined,
            )
          }

          yield* streamingCapture.finish
        }).pipe(Effect.ensuring(Ref.set(config.pttActiveRef, false)))
      }
    }),
  )
