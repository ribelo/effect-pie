import { Console, Duration, Effect, Fiber, Option, Queue, Ref, Stream, type Cause } from "effect"

import type { PulseAudioClient } from "../../pulse/client.js"
import { makePcmRecordOptions } from "../../pulse/defs.js"
import { createRecordStream } from "../../pulse/stream.js"
import { KeyboardMonitorService, type PttKeyboardError } from "../../keyboard/monitor.js"
import type { TextInjectionBackendService } from "../../input/textInjection.js"
import type { DesktopSession } from "../../desktop/session.js"
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
import type { AssistantRecordingMode } from "./recordingState.js"

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
  readonly diagnostics?: AssistantDiagnostics | undefined
  readonly pttTranscribeKeysym: Option.Option<number>
  readonly pttTranslateKeysym: Option.Option<number>
}): Effect.Effect<
  never,
  CliError | PttKeyboardError,
  | PulseAudioClient
  | KeyboardMonitorService
  | DesktopSession
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
        SttService | DesktopSession | TextInjectionBackendService
      > =>
        Effect.gen(function* () {
          const audioQueue = yield* Queue.unbounded<Uint8Array, Cause.Done>()
          const audio = Stream.fromQueue(audioQueue)
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

          const fiber = yield* transcript.pipe(
            Effect.mapError((cause) => {
              const message =
                cause["_tag"] === "OpenRouterSttError" ||
                cause["_tag"] === "CodexRealtimeSttError" ||
                cause["_tag"] === "CodexAuthError" ||
                cause["_tag"] === "SttDispatchError"
                  ? `${mode === "transcribe" ? "PTT transcription" : "PTT translation"} failed: ${cause.message}`
                  : `Failed to type streamed ${mode} text: ${cause.message}`

              return toPttKeyboardError(message, cause)
            }),
            Effect.asVoid,
            (effect) => Effect.forkChild(effect, { startImmediately: true }),
          )

          return {
            offer: (chunk) => Queue.offer(audioQueue, chunk).pipe(Effect.asVoid),
            finish: Queue.end(audioQueue).pipe(Effect.andThen(Fiber.join(fiber))),
            cancel: Queue.end(audioQueue).pipe(
              Effect.andThen(Fiber.interrupt(fiber)),
              Effect.ignore,
            ),
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

      yield* Effect.addFinalizer(() =>
        Effect.all(
          [
            Ref.set(config.pttActiveRef, false),
            Ref.get(streamingCaptureRef).pipe(
              Effect.flatMap((streamingCapture) =>
                streamingCapture === undefined ? Effect.void : streamingCapture.cancel,
              ),
              Effect.ignore,
            ),
            config.setRecordingMode(undefined).pipe(Effect.orDie),
          ],
          {
            discard: true,
          },
        ),
      )

      const deadInputDetectorRef = yield* Ref.make(pttDeadInputDetectorInitial())

      yield* createRecordStream(
        makePcmRecordOptions({
          rate: DEFAULT_ASSISTANT_SAMPLE_RATE,
          fragmentSize: DEFAULT_ASSISTANT_PTT_FRAGMENT_SIZE,
          sourceName: config.sourceName,
        }),
      ).pipe(
        Stream.runForEach((chunk) =>
          Effect.gen(function* () {
            const state = yield* Ref.get(captureStateRef)
            const isActive = pttCaptureIsAcceptingChunks(state)

            yield* Ref.update(deadInputDetectorRef, (detector) =>
              pttDeadInputDetectorSync(detector, isActive),
            )

            if (!isActive) {
              return
            }

            yield* Ref.update(captureChunksRef, (chunks) => {
              const next = chunks.slice()
              next.push(chunk)
              return next
            })

            const streamingCapture = yield* Ref.get(streamingCaptureRef)
            if (streamingCapture !== undefined) {
              yield* streamingCapture.offer(chunk)
            }

            const { detector: nextDetector, warn } = pttDeadInputDetectorProcessChunk(
              yield* Ref.get(deadInputDetectorRef),
              chunk,
            )
            yield* Ref.set(deadInputDetectorRef, nextDetector)

            if (warn) {
              yield* Console.log("[assistant-ptt] No input detected; microphone probably muted")
              yield* notifyWarning(
                "pie: no microphone input",
                "No input detected during push-to-talk. Your microphone may be muted.",
              )
            }
          }),
        ),
        Effect.forkScoped,
      )

      mainLoop: while (true) {
        const event = yield* Queue.take(eventQueue)

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
          yield* Ref.set(captureStartedAtRef, Date.now())
          yield* Ref.set(captureModeRef, mode)
          const streamingCapture = yield* makeStreamingCapture(mode)
          yield* Ref.set(streamingCaptureRef, streamingCapture)
          yield* Ref.set(captureStateRef, nextState)
          yield* Ref.set(config.pttActiveRef, true)
          yield* config.setRecordingMode(recordingMode)
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
                orElse: () => Effect.succeed(undefined),
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
        yield* Ref.set(captureModeRef, undefined)
        yield* config.setRecordingMode(undefined)

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
