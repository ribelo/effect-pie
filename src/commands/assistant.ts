import { Console, Duration, Effect, Fiber, Option, Queue, Ref, Stream } from "effect"
import * as path from "node:path"
import { mkdir as mkdirNode, writeFile as writeNodeFile } from "node:fs/promises"
import { loadSttRuntimeConfig, type SttConfigError, type SttRuntimeConfig } from "../stt/config.js"
import {
  transcribeAndTranslatePcmWithOpenRouter,
  transcribePcmWithOpenRouter,
  type OpenRouterSttError,
} from "../stt/openrouter.js"
import { PulseAudioClient } from "../pulse/client.js"
import { makePcmRecordOptions } from "../pulse/defs.js"
import { createRecordStream } from "../pulse/stream.js"
import { MIN_GAIN_TO_APPLY, normalizePcmForStt, pcmPeak, pcmRms } from "../audio/pcm.js"
import { KeyboardMonitorService, type PttKeyboardError } from "../keyboard/monitor.js"
import { validateWakewordAssets, type WakewordAssetError } from "../wakeword/assets.js"
import { createWakewordTelemetryStream } from "../wakeword/live.js"
import { loadWakewordModelSessions, type WakewordRuntimeError } from "../wakeword/onnx.js"
import { makeWakewordPipeline, type WakewordPipelineError } from "../wakeword/pipeline.js"
import { createWakewordTriggerMachine } from "../wakeword/trigger.js"
import { typeTextInFocusedApp, normalizeTextForInjection } from "../input/textInjection.js"
import { AssistantDiagnostics, isShellTraceEnabled } from "../assistant/diagnostics.js"
import { notifyWarning } from "../desktop/notification.js"
import {
  pttCaptureIdle,
  pttCaptureIsAcceptingChunks,
  pttCapturePostRollRemainingMs,
  pttCaptureRelease,
  pttCaptureStart,
  type PttCaptureState,
} from "../ptt/capture.js"
import {
  pttDeadInputDetectorInitial,
  pttDeadInputDetectorProcessChunk,
  pttDeadInputDetectorSync,
} from "../ptt/deadInput.js"
import { toPttKeyboardError } from "./ptt.js"
import { EFFECT_PI_RUNTIME_DIR } from "../paths.js"
import { CliError, concatChunks } from "./shared.js"
import { recordPcmUntilTrailingSilence } from "./audioCapture.js"
import {
  calibrationPathFor,
  detectionTuningPathFor,
  readCalibrationSnapshot,
  readDetectionTuningSnapshot,
} from "./wakewordHelpers.js"

const DEFAULT_ASSISTANT_WAKEWORD_MODEL_FILE = "ok_pie.json"
const DEFAULT_ASSISTANT_PTT_TRANSCRIBE_KEYSYM = 65478
const DEFAULT_ASSISTANT_PTT_TRANSLATE_KEYSYM = 65479
const DEFAULT_ASSISTANT_SAMPLE_RATE = 16_000
const DEFAULT_ASSISTANT_WAKEWORD_FRAGMENT_SIZE = 1024
const DEFAULT_ASSISTANT_PTT_FRAGMENT_SIZE = 4096
const DEFAULT_ASSISTANT_MIN_DURATION_MS = 120
const DEFAULT_ASSISTANT_WAKEWORD_SPEECH_START_TIMEOUT_SECONDS = 8
const ASSISTANT_RECORDING_STATE_PATH = path.join(EFFECT_PI_RUNTIME_DIR, "recording.json")

const resolveWakewordSpeechStartTimeoutSeconds = (config: {
  readonly silenceSeconds: number
  readonly maxSeconds: number
}): number =>
  Math.min(
    config.maxSeconds,
    Math.max(DEFAULT_ASSISTANT_WAKEWORD_SPEECH_START_TIMEOUT_SECONDS, config.silenceSeconds + 2),
  )

type AssistantRecordingMode = "ptt-transcribe" | "ptt-translate" | "wakeword"

type AssistantRecordingState = {
  readonly active: boolean
  readonly mode: AssistantRecordingMode | "idle"
  readonly startedAt: string | null
  readonly updatedAt: string
}

type AssistantRecordingRuntimeState = {
  readonly mode: AssistantRecordingMode | undefined
  readonly startedAtMs: number | undefined
}

const persistAssistantRecordingState = (
  state: AssistantRecordingState,
): Effect.Effect<void, CliError> =>
  Effect.tryPromise({
    try: async () => {
      await mkdirNode(path.dirname(ASSISTANT_RECORDING_STATE_PATH), { recursive: true })
      await writeNodeFile(
        ASSISTANT_RECORDING_STATE_PATH,
        `${JSON.stringify(state, null, 2)}\n`,
        "utf8",
      )
    },
    catch: (cause) =>
      new CliError({
        message: `Failed to write assistant recording state at ${ASSISTANT_RECORDING_STATE_PATH}`,
        cause,
      }),
  })

const setAssistantRecordingMode = (config: {
  readonly ref: Ref.Ref<AssistantRecordingRuntimeState>
  readonly mode: AssistantRecordingMode | undefined
}): Effect.Effect<void> =>
  Effect.gen(function* () {
    const nowMs = Date.now()
    const nowIso = new Date(nowMs).toISOString()

    const state = yield* Ref.modify(config.ref, (current) => {
      if (config.mode === undefined) {
        const nextState: AssistantRecordingState = {
          active: false,
          mode: "idle",
          startedAt: null,
          updatedAt: nowIso,
        }

        const nextRuntime: AssistantRecordingRuntimeState = {
          mode: undefined,
          startedAtMs: undefined,
        }

        return [nextState, nextRuntime] as const
      }

      const startedAtMs =
        current.mode === config.mode && current.startedAtMs !== undefined
          ? current.startedAtMs
          : nowMs

      const nextState: AssistantRecordingState = {
        active: true,
        mode: config.mode,
        startedAt: new Date(startedAtMs).toISOString(),
        updatedAt: nowIso,
      }

      const nextRuntime: AssistantRecordingRuntimeState = {
        mode: config.mode,
        startedAtMs,
      }

      return [nextState, nextRuntime] as const
    })

    yield* persistAssistantRecordingState(state).pipe(
      Effect.catch((cause: CliError) => Console.log(`[assistant] ${cause.message}`)),
    )
  })

const normalizeWakewordModelName = (modelName: string): string =>
  modelName.endsWith(".json") ? modelName.slice(0, -".json".length) : modelName

const resolveDefaultSourceName = (): Effect.Effect<string, CliError, PulseAudioClient> =>
  Effect.gen(function* () {
    const client = yield* PulseAudioClient

    yield* client.connect().pipe(
      Effect.mapError(
        (cause) =>
          new CliError({
            message: "Failed to connect to PulseAudio",
            cause,
          }),
      ),
    )

    const serverInfo = yield* client.getServerInfo.pipe(
      Effect.mapError(
        (cause) =>
          new CliError({
            message: "Failed to resolve default PulseAudio source",
            cause,
          }),
      ),
      Effect.ensuring(client.disconnect),
    )

    if (serverInfo.defaultSource.length === 0) {
      return yield* new CliError({
        message: "PulseAudio did not return a default capture source",
      })
    }

    return serverInfo.defaultSource
  })

const runAssistantWakewordTranscribeLoop = (config: {
  readonly sourceName: string
  readonly sttConfig: SttRuntimeConfig
  readonly pttActiveRef: Ref.Ref<boolean>
  readonly setRecordingMode: (mode: AssistantRecordingMode | undefined) => Effect.Effect<void>
  readonly diagnostics?: AssistantDiagnostics | undefined
}): Effect.Effect<void, CliError, PulseAudioClient> =>
  Effect.gen(function* () {
    const assets = yield* validateWakewordAssets({
      wakewordModels: [DEFAULT_ASSISTANT_WAKEWORD_MODEL_FILE],
    }).pipe(
      Effect.mapError(
        (cause: WakewordAssetError) =>
          new CliError({
            message: `Wakeword assets are invalid: ${cause.message}`,
            cause,
          }),
      ),
    )

    const sessions = yield* loadWakewordModelSessions(assets).pipe(
      Effect.mapError(
        (cause: WakewordRuntimeError) =>
          new CliError({
            message: `Failed to initialize wakeword model sessions: ${cause.message}`,
            cause,
          }),
      ),
    )

    const pipeline = yield* makeWakewordPipeline(sessions).pipe(
      Effect.mapError(
        (cause: WakewordPipelineError) =>
          new CliError({
            message: `Failed to initialize wakeword inference pipeline: ${cause.message}`,
            cause,
          }),
      ),
    )

    const modelNames = Object.keys(assets.wakewordModelPaths)
    const selectedModelName =
      modelNames.find((name) => normalizeWakewordModelName(name) === "ok_pie") ?? modelNames[0]

    if (selectedModelName === undefined) {
      return yield* new CliError({
        message: "No wakeword models are available",
      })
    }

    const normalizedModelName = normalizeWakewordModelName(selectedModelName)
    const tuningPath = detectionTuningPathFor(normalizedModelName)
    const calibrationPath = calibrationPathFor(normalizedModelName)

    const tuningSnapshot = yield* readDetectionTuningSnapshot(tuningPath)
    const calibrationSnapshot = yield* readCalibrationSnapshot(calibrationPath)

    const triggerMachine = yield* createWakewordTriggerMachine({
      threshold: tuningSnapshot?.trigger.threshold ?? 0.5,
      smoothingWindow: tuningSnapshot?.trigger.smoothingWindow ?? 4,
      consecutiveFrames: tuningSnapshot?.trigger.consecutiveFrames ?? 3,
      cooldownMs: tuningSnapshot?.trigger.cooldownMs ?? 1500,
    })

    const isTranscribingRef = yield* Ref.make(false)

    const wakewordRecordOptions = makePcmRecordOptions({
      rate: DEFAULT_ASSISTANT_SAMPLE_RATE,
      fragmentSize: DEFAULT_ASSISTANT_WAKEWORD_FRAGMENT_SIZE,
      sourceName: config.sourceName,
    })

    yield* Console.log(
      `[assistant] Wakeword listener armed: model=${selectedModelName} source=${config.sourceName}`,
    )

    if (tuningSnapshot !== undefined) {
      yield* Console.log(`[assistant] Wakeword tuning loaded: ${tuningPath}`)
    }

    return yield* createWakewordTelemetryStream({
      pipeline,
      trigger: triggerMachine,
      recordStream: wakewordRecordOptions,
    }).pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          if (event.type !== "trigger" || event.event.model !== selectedModelName) {
            return
          }

          const pttActive = yield* Ref.get(config.pttActiveRef)
          if (pttActive) {
            return
          }

          const alreadyTranscribing = yield* Ref.get(isTranscribingRef)
          if (alreadyTranscribing) {
            return
          }

          yield* Ref.set(isTranscribingRef, true)
          config.diagnostics?.wakewordTrigger(selectedModelName)

          const triggerEffect = Effect.gen(function* () {
            config.diagnostics?.setState("wakeword-dictation")
            const dictationSilenceSeconds =
              config.sttConfig.openrouter.wakewordDictationSilenceSeconds
            const dictationMaxSeconds = config.sttConfig.openrouter.wakewordDictationMaxSeconds
            const dictationSpeechStartTimeoutSeconds = resolveWakewordSpeechStartTimeoutSeconds({
              silenceSeconds: dictationSilenceSeconds,
              maxSeconds: dictationMaxSeconds,
            })
            const dictationSpeechRmsThreshold =
              calibrationSnapshot?.resolved.speechRms ??
              config.sttConfig.openrouter.wakewordDictationSpeechRmsThreshold

            yield* Console.log(
              `[wakeword-transcribe] Trigger detected (${selectedModelName}). Dictation capture started (silence=${dictationSilenceSeconds}s, max=${dictationMaxSeconds}s, speech_start_timeout=${dictationSpeechStartTimeoutSeconds}s, speech_rms=${dictationSpeechRmsThreshold.toFixed(4)})...`,
            )

            yield* config.setRecordingMode("wakeword")

            const rawPcmBytes = yield* recordPcmUntilTrailingSilence({
              silenceSeconds: dictationSilenceSeconds,
              maxSeconds: dictationMaxSeconds,
              speechStartTimeoutSeconds: dictationSpeechStartTimeoutSeconds,
              speechRmsThreshold: dictationSpeechRmsThreshold,
              fragmentSize: DEFAULT_ASSISTANT_PTT_FRAGMENT_SIZE,
              sampleRate: DEFAULT_ASSISTANT_SAMPLE_RATE,
              channels: 1,
              sourceName: config.sourceName,
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new CliError({
                    message: "Failed to capture wakeword dictation clip",
                    cause,
                  }),
              ),
              Effect.ensuring(config.setRecordingMode(undefined)),
            )

            const { normalizedBytes: pcmBytes, gain } = normalizePcmForStt(rawPcmBytes)
            if (gain > MIN_GAIN_TO_APPLY) {
              yield* Console.log(
                `[wakeword-transcribe] Normalized dictation (rms=${pcmRms(rawPcmBytes).toFixed(4)} peak=${pcmPeak(rawPcmBytes).toFixed(4)} gain=${gain.toFixed(2)})`,
              )
            }

            config.diagnostics?.setState("stt")
            config.diagnostics?.sttStart(config.sttConfig.openrouter.transcriptionModel)
            const transcript = yield* transcribePcmWithOpenRouter({
              model: config.sttConfig.openrouter.transcriptionModel,
              pcmBytes,
              sampleRate: DEFAULT_ASSISTANT_SAMPLE_RATE,
              language: config.sttConfig.openrouter.transcriptionLanguage,
              promptTemplate: config.sttConfig.transcriptionPrompt,
            }).pipe(
              Effect.mapError(
                (cause: OpenRouterSttError) =>
                  new CliError({
                    message: `Wakeword transcription failed: ${cause.message}`,
                    cause,
                  }),
              ),
            )

            config.diagnostics?.sttComplete(transcript.length)

            const text = transcript.trim()
            const injectableText = normalizeTextForInjection(text)

            if (injectableText.length === 0) {
              yield* Console.log("[wakeword-transcribe] Ignored empty transcript")
              config.diagnostics?.setState("idle")
              return
            }

            yield* Console.log("[wakeword-transcribe] Will type (start)")
            yield* Console.log(injectableText)
            yield* Console.log("[wakeword-transcribe] Will type (end)")

            config.diagnostics?.setState("injection")
            config.diagnostics?.injectionStart(injectableText.length)
            const typed = yield* typeTextInFocusedApp(injectableText).pipe(
              Effect.mapError(
                (cause) =>
                  new CliError({
                    message:
                      cause instanceof Error
                        ? `Failed to type wakeword transcript: ${cause.message}`
                        : "Failed to type wakeword transcript",
                    cause,
                  }),
              ),
            )
            config.diagnostics?.injectionComplete()
            config.diagnostics?.setState("idle")

            yield* Console.log(
              `[wakeword-transcribe] Typed ${typed.text.length} chars with ${typed.backend} (${typed.sessionType})`,
            )
          }).pipe(
            Effect.catch((cause: CliError) => {
              config.diagnostics?.sttFailure(cause.message)
              config.diagnostics?.injectionFailure(cause.message)
              return Console.log(`[wakeword-transcribe] ${cause.message}`)
            }),
            Effect.ensuring(Ref.set(isTranscribingRef, false)),
          )

          yield* Effect.forkDetach(triggerEffect)
        }),
      ),
      Effect.mapError(
        (cause) =>
          new CliError({
            message: "Wakeword listener failed",
            cause,
          }),
      ),
    )
  })

type AssistantPttMode = "transcribe" | "translate"

const runAssistantPttCombinedLoop = (config: {
  readonly sourceName: string
  readonly sttConfig: SttRuntimeConfig
  readonly pttActiveRef: Ref.Ref<boolean>
  readonly setRecordingMode: (mode: AssistantRecordingMode | undefined) => Effect.Effect<void>
  readonly diagnostics?: AssistantDiagnostics | undefined
  readonly pttTranscribeKeysym: Option.Option<number>
  readonly pttTranslateKeysym: Option.Option<number>
}): Effect.Effect<never, PttKeyboardError, PulseAudioClient | KeyboardMonitorService> =>
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

      const sourceLanguage = config.sttConfig.openrouter.translationSourceLanguage
      const targetLanguage = config.sttConfig.openrouter.translationTargetLanguage

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

      yield* Effect.addFinalizer(() =>
        Effect.all([Ref.set(config.pttActiveRef, false), config.setRecordingMode(undefined)], {
          discard: true,
        }),
      )

      const deadInputDetectorRef = yield* Ref.make(pttDeadInputDetectorInitial())

      const recordFiber = yield* createRecordStream(
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
        Effect.forkDetach,
      )

      yield* Effect.addFinalizer(() => Fiber.interrupt(recordFiber).pipe(Effect.ignore))

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
          const remaining = pttCapturePostRollRemainingMs(postRollState, Date.now())
          if (remaining <= 0) {
            break postRollLoop
          }

          const nextEvent = yield* Queue.take(eventQueue).pipe(
            Effect.timeoutOrElse({
              duration: Duration.millis(remaining),
              orElse: () => Effect.succeed(undefined),
            }),
          )

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

          const capturedBytes = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
          config.diagnostics?.pttFinalize(durationMs)
          yield* Console.log(
            `[${modePrefix}] Capture stopped (${durationMs}ms, ${capturedBytes} bytes)`,
          )

          if (durationMs < DEFAULT_ASSISTANT_MIN_DURATION_MS) {
            yield* Console.log(
              `[${modePrefix}] Ignored short clip (${durationMs}ms < ${DEFAULT_ASSISTANT_MIN_DURATION_MS}ms)`,
            )
            config.diagnostics?.setState("idle")
            return
          }

          const rawPcmBytes = concatChunks(chunks)
          if (rawPcmBytes.length === 0) {
            yield* Console.log(`[${modePrefix}] Ignored empty clip`)
            config.diagnostics?.setState("idle")
            return
          }

          const { normalizedBytes: pcmBytes, gain } = normalizePcmForStt(rawPcmBytes)
          if (gain > MIN_GAIN_TO_APPLY) {
            yield* Console.log(
              `[${modePrefix}] Normalized clip (rms=${pcmRms(rawPcmBytes).toFixed(4)} peak=${pcmPeak(rawPcmBytes).toFixed(4)} gain=${gain.toFixed(2)})`,
            )
          }

          if (mode === "transcribe") {
            config.diagnostics?.setState("stt")
            config.diagnostics?.sttStart(config.sttConfig.openrouter.transcriptionModel)
            const transcript = yield* transcribePcmWithOpenRouter({
              model: config.sttConfig.openrouter.transcriptionModel,
              pcmBytes,
              sampleRate: DEFAULT_ASSISTANT_SAMPLE_RATE,
              language: config.sttConfig.openrouter.transcriptionLanguage,
              promptTemplate: config.sttConfig.transcriptionPrompt,
            }).pipe(
              Effect.mapError((cause: OpenRouterSttError) => {
                config.diagnostics?.sttFailure(cause.message)
                return toPttKeyboardError(`PTT transcription failed: ${cause.message}`, cause)
              }),
            )
            config.diagnostics?.sttComplete(transcript.length)

            const text = transcript.trim()
            const injectableText = normalizeTextForInjection(text)

            if (injectableText.length === 0) {
              yield* Console.log("[assistant-ptt-transcribe] Ignored empty transcript")
              config.diagnostics?.setState("idle")
              return
            }

            yield* Console.log("[assistant-ptt-transcribe] Will type (start)")
            yield* Console.log(injectableText)
            yield* Console.log("[assistant-ptt-transcribe] Will type (end)")

            config.diagnostics?.setState("injection")
            config.diagnostics?.injectionStart(injectableText.length)
            const typed = yield* typeTextInFocusedApp(injectableText).pipe(
              Effect.mapError((cause) => {
                config.diagnostics?.injectionFailure(
                  cause instanceof Error ? cause.message : String(cause),
                )
                return toPttKeyboardError(
                  cause instanceof Error
                    ? `Failed to type transcript text: ${cause.message}`
                    : "Failed to type transcript text",
                  cause,
                )
              }),
            )
            config.diagnostics?.injectionComplete()
            config.diagnostics?.setState("idle")

            yield* Console.log(
              `[assistant-ptt-transcribe] Typed ${typed.text.length} chars with ${typed.backend} (${typed.sessionType})`,
            )
            return
          }

          config.diagnostics?.setState("stt")
          config.diagnostics?.sttStart(config.sttConfig.openrouter.translationModel)
          const translated = yield* transcribeAndTranslatePcmWithOpenRouter({
            model: config.sttConfig.openrouter.translationModel,
            pcmBytes,
            sampleRate: DEFAULT_ASSISTANT_SAMPLE_RATE,
            sourceLanguage,
            targetLanguage,
            promptTemplate: config.sttConfig.translationPrompt,
          }).pipe(
            Effect.mapError((cause: OpenRouterSttError) => {
              config.diagnostics?.sttFailure(cause.message)
              return toPttKeyboardError(`PTT translation failed: ${cause.message}`, cause)
            }),
          )
          config.diagnostics?.sttComplete(translated.length)

          const text = translated.trim()
          const injectableText = normalizeTextForInjection(text)

          if (injectableText.length === 0) {
            yield* Console.log("[assistant-ptt-translate] Ignored empty translation")
            config.diagnostics?.setState("idle")
            return
          }

          yield* Console.log("[assistant-ptt-translate] Will type (start)")
          yield* Console.log(injectableText)
          yield* Console.log("[assistant-ptt-translate] Will type (end)")

          config.diagnostics?.setState("injection")
          config.diagnostics?.injectionStart(injectableText.length)
          const typed = yield* typeTextInFocusedApp(injectableText).pipe(
            Effect.mapError((cause) => {
              config.diagnostics?.injectionFailure(
                cause instanceof Error ? cause.message : String(cause),
              )
              return toPttKeyboardError(
                cause instanceof Error
                  ? `Failed to type translated text: ${cause.message}`
                  : "Failed to type translated text",
                cause,
              )
            }),
          )
          config.diagnostics?.injectionComplete()
          config.diagnostics?.setState("idle")

          yield* Console.log(
            `[assistant-ptt-translate] Typed ${typed.text.length} chars with ${typed.backend} (${typed.sessionType})`,
          )
        }).pipe(Effect.ensuring(Ref.set(config.pttActiveRef, false)))
      }
    }),
  )

export const runAssistantDefaultCommand = (config: {
  readonly "ptt-transcribe-keysym": Option.Option<number>
  readonly "ptt-translate-keysym": Option.Option<number>
}): Effect.Effect<
  void,
  CliError | SttConfigError | PttKeyboardError | Error,
  PulseAudioClient | KeyboardMonitorService
> =>
  Effect.gen(function* () {
    const sttConfig = yield* loadSttRuntimeConfig().pipe(
      Effect.mapError(
        (cause: SttConfigError) =>
          new CliError({
            message: `Failed to load STT config: ${cause.message}`,
            cause,
          }),
      ),
    )

    const sourceName = yield* resolveDefaultSourceName()
    const wakewordSpeechStartTimeoutSeconds = resolveWakewordSpeechStartTimeoutSeconds({
      silenceSeconds: sttConfig.openrouter.wakewordDictationSilenceSeconds,
      maxSeconds: sttConfig.openrouter.wakewordDictationMaxSeconds,
    })

    yield* Console.log("[assistant] Running default assistant mode")
    if (sttConfig.openrouter.wakewordEnabled) {
      yield* Console.log(
        `[assistant] Wakeword model=${DEFAULT_ASSISTANT_WAKEWORD_MODEL_FILE} -> transcription (${sttConfig.openrouter.transcriptionLanguage})`,
      )
    } else {
      yield* Console.log("[assistant] Wakeword disabled (PTT-only mode)")
    }
    yield* Console.log(
      `[assistant] PTT transcribe keysym=${Option.getOrElse(config["ptt-transcribe-keysym"], () => DEFAULT_ASSISTANT_PTT_TRANSCRIBE_KEYSYM)}, PTT translate keysym=${Option.getOrElse(config["ptt-translate-keysym"], () => DEFAULT_ASSISTANT_PTT_TRANSLATE_KEYSYM)}`,
    )
    if (sttConfig.openrouter.wakewordEnabled) {
      yield* Console.log(
        `[assistant] Wakeword dictation: silence=${sttConfig.openrouter.wakewordDictationSilenceSeconds}s max=${sttConfig.openrouter.wakewordDictationMaxSeconds}s speech_start_timeout=${wakewordSpeechStartTimeoutSeconds}s speech_rms=${sttConfig.openrouter.wakewordDictationSpeechRmsThreshold.toFixed(4)}`,
      )
    }
    yield* Console.log("[assistant] Focus the target app (for example Slack) to receive typed text")
    yield* Console.log("[assistant] Press Ctrl+C to stop all listeners")

    const pttActiveRef = yield* Ref.make(false)
    const recordingStateRef = yield* Ref.make<AssistantRecordingRuntimeState>({
      mode: undefined,
      startedAtMs: undefined,
    })
    const setRecordingMode = (mode: AssistantRecordingMode | undefined) =>
      setAssistantRecordingMode({
        ref: recordingStateRef,
        mode,
      })

    yield* setRecordingMode(undefined)
    yield* Console.log(`[assistant] Recording state file: ${ASSISTANT_RECORDING_STATE_PATH}`)

    const diagnostics = isShellTraceEnabled(process.env["PIE_SHELL_TRACE"])
      ? new AssistantDiagnostics()
      : undefined

    const effect = Effect.all(
      [
        runAssistantPttCombinedLoop({
          sourceName,
          sttConfig,
          pttActiveRef,
          setRecordingMode,
          diagnostics,
          pttTranscribeKeysym: config["ptt-transcribe-keysym"],
          pttTranslateKeysym: config["ptt-translate-keysym"],
        }),
        ...(sttConfig.openrouter.wakewordEnabled
          ? [
              runAssistantWakewordTranscribeLoop({
                sourceName,
                sttConfig,
                pttActiveRef,
                setRecordingMode,
                diagnostics,
              }),
            ]
          : []),
      ],
      {
        concurrency: "unbounded",
        discard: true,
      },
    ).pipe(Effect.ensuring(setRecordingMode(undefined)))

    return yield* effect.pipe(
      Effect.tapError((cause) =>
        Effect.gen(function* () {
          if (diagnostics !== undefined) {
            diagnostics.setState("idle")
            yield* Console.error(diagnostics.renderSnapshot())
          }
        }),
      ),
    )
  })
