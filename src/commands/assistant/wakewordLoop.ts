import { Console, Effect, Fiber, Queue, Ref, Stream, type Cause } from "effect"

import type { PulseAudioClient } from "../../pulse/client.js"
import { makePcmRecordOptions } from "../../pulse/defs.js"
import { validateWakewordAssets, type WakewordAssetError } from "../../wakeword/assets.js"
import { createWakewordTelemetryStream } from "../../wakeword/live.js"
import { loadWakewordModelSessions, type WakewordRuntimeError } from "../../wakeword/onnx.js"
import { makeWakewordPipeline, type WakewordPipelineError } from "../../wakeword/pipeline.js"
import { createWakewordTriggerMachine } from "../../wakeword/trigger.js"
import type { TextInjectionBackendService } from "../../input/textInjection.js"
import type { DesktopSession } from "../../desktop/session.js"
import type { Niri } from "../../niri/service.js"
import type { AssistantDiagnostics } from "../../assistant/diagnostics.js"
import { recordPcmUntilTrailingSilence } from "../audioCapture.js"
import {
  calibrationPathFor,
  detectionTuningPathFor,
  readCalibrationSnapshot,
} from "../wakewordHelpers.js"
import { readDetectionTuningSnapshot, type WakewordSnapshotError } from "../../wakeword/tuning.js"
import type { SttService } from "../../stt/service.js"
import { transcribeStreamAndInject } from "../../stt/transcribeAndInject.js"
import type { SttRuntimeConfig } from "../../stt/config.js"
import { CliError } from "../shared.js"
import {
  DEFAULT_ASSISTANT_WAKEWORD_MODEL_FILE,
  DEFAULT_ASSISTANT_SAMPLE_RATE,
  DEFAULT_ASSISTANT_WAKEWORD_FRAGMENT_SIZE,
  DEFAULT_ASSISTANT_PTT_FRAGMENT_SIZE,
  resolveWakewordSpeechStartTimeoutSeconds,
} from "./constants.js"
import {
  tryStartRecording,
  stopRecording,
  type AssistantRecordingMode,
  type AssistantRecordingRuntimeState,
} from "./recordingState.js"

const normalizeWakewordModelName = (modelName: string): string =>
  modelName.endsWith(".json") ? modelName.slice(0, -".json".length) : modelName

export const runAssistantWakewordTranscribeLoop = (config: {
  readonly sourceName: string
  readonly sttConfig: SttRuntimeConfig
  readonly pttActiveRef: Ref.Ref<boolean>
  readonly setRecordingMode: (
    mode: AssistantRecordingMode | undefined,
  ) => Effect.Effect<void, CliError>
  readonly recordingCoordinatorRef: Ref.Ref<AssistantRecordingRuntimeState>
  readonly diagnostics?: AssistantDiagnostics | undefined
  readonly recordingStateRef: Ref.Ref<AssistantRecordingRuntimeState>
}): Effect.Effect<
  void,
  CliError,
  PulseAudioClient | DesktopSession | Niri | TextInjectionBackendService | SttService
> =>
  Effect.scoped(
    Effect.gen(function* () {
      const outerScope = yield* Effect.scope

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

      yield* Effect.addFinalizer(() => sessions.dispose)

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

      const tuningSnapshot = yield* readDetectionTuningSnapshot(tuningPath).pipe(
        Effect.mapError(
          (cause: WakewordSnapshotError) =>
            new CliError({
              message: `Missing wakeword tuning for '${normalizedModelName}'. Run 'pie wakeword-tune --name ${normalizedModelName}' first.`,
              cause,
            }),
        ),
      )
      const calibrationSnapshot = yield* readCalibrationSnapshot(calibrationPath).pipe(
        Effect.mapError(
          (cause) =>
            new CliError({
              message: `Failed to read wakeword calibration for '${normalizedModelName}': ${cause.message}`,
              cause,
            }),
        ),
      )

      const triggerMachine = createWakewordTriggerMachine({
        threshold: tuningSnapshot.trigger.threshold,
        smoothingWindow: tuningSnapshot.trigger.smoothingWindow,
        consecutiveFrames: tuningSnapshot.trigger.consecutiveFrames,
        cooldownMs: tuningSnapshot.trigger.cooldownMs,
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

      yield* Console.log(`[assistant] Wakeword tuning loaded: ${tuningPath}`)

      return yield* createWakewordTelemetryStream({
        pipeline,
        trigger: triggerMachine,
        recordStream: wakewordRecordOptions,
      }).pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            const daemonState = yield* Ref.get(config.recordingStateRef)
            if (!daemonState.enabled) {
              return
            }

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
              const dictationSilenceSeconds = config.sttConfig.wakewordDictationSilenceSeconds
              const dictationMaxSeconds = config.sttConfig.wakewordDictationMaxSeconds
              const dictationSpeechStartTimeoutSeconds = resolveWakewordSpeechStartTimeoutSeconds({
                silenceSeconds: dictationSilenceSeconds,
                maxSeconds: dictationMaxSeconds,
              })
              const dictationSpeechRmsThreshold =
                calibrationSnapshot?.resolved.speechRms ??
                config.sttConfig.wakewordDictationSpeechRmsThreshold

              yield* Console.log(
                `[wakeword-transcribe] Trigger detected (${selectedModelName}). Dictation capture started (silence=${dictationSilenceSeconds}s, max=${dictationMaxSeconds}s, speech_start_timeout=${dictationSpeechStartTimeoutSeconds}s, speech_rms=${dictationSpeechRmsThreshold.toFixed(4)})...`,
              )

              const result = yield* tryStartRecording({
                ref: config.recordingCoordinatorRef,
                mode: "wakeword",
              })
              if (result["_tag"] === "Busy") {
                yield* Console.log(`[wakeword-transcribe] Ignored: ${result.activeMode} is active`)
                return
              }
              if (result["_tag"] === "Disabled") {
                yield* Console.log(`[wakeword-transcribe] Ignored: PIE is disabled`)
                return
              }

              const audioQueue = yield* Queue.unbounded<Uint8Array, Cause.Done>()
              const transcriptionFiber = yield* transcribeStreamAndInject({
                operation: "transcribe",
                model: config.sttConfig.transcriptionModel,
                audio: Stream.fromQueue(audioQueue),
                sampleRate: DEFAULT_ASSISTANT_SAMPLE_RATE,
                language: config.sttConfig.transcriptionLanguage,
                promptTemplate: config.sttConfig.transcriptionPrompt,
                logPrefix: "wakeword-transcribe",
                diagnostics: config.diagnostics,
              }).pipe(
                Effect.mapError((cause) => {
                  const message =
                    cause["_tag"] === "OpenRouterSttError" ||
                    cause["_tag"] === "CodexRealtimeSttError" ||
                    cause["_tag"] === "CodexAuthError" ||
                    cause["_tag"] === "SttDispatchError" ||
                    (cause["_tag"]?.startsWith("Niri") ?? false)
                      ? `Wakeword transcription failed: ${cause.message}`
                      : `Failed to type wakeword transcript: ${cause.message}`

                  return new CliError({
                    message,
                    cause,
                  })
                }),
                Effect.asVoid,
                (effect) => Effect.forkChild(effect, { startImmediately: true }),
              )

              yield* recordPcmUntilTrailingSilence({
                silenceSeconds: dictationSilenceSeconds,
                maxSeconds: dictationMaxSeconds,
                speechStartTimeoutSeconds: dictationSpeechStartTimeoutSeconds,
                speechRmsThreshold: dictationSpeechRmsThreshold,
                fragmentSize: DEFAULT_ASSISTANT_PTT_FRAGMENT_SIZE,
                sampleRate: DEFAULT_ASSISTANT_SAMPLE_RATE,
                channels: 1,
                sourceName: config.sourceName,
                onChunk: (chunk) => Queue.offer(audioQueue, chunk).pipe(Effect.asVoid),
              }).pipe(
                Effect.mapError(
                  (cause) =>
                    new CliError({
                      message: "Failed to capture wakeword dictation clip",
                      cause,
                    }),
                ),
                Effect.tapError(() =>
                  Queue.end(audioQueue).pipe(
                    Effect.andThen(Fiber.interrupt(transcriptionFiber)),
                    Effect.ignore,
                  ),
                ),
                Effect.onExit(() =>
                  Effect.gen(function* () {
                    const runtime = yield* Ref.get(config.recordingCoordinatorRef)
                    if (runtime.mode === "wakeword") {
                      yield* stopRecording({
                        ref: config.recordingCoordinatorRef,
                        mode: "wakeword",
                      }).pipe(Effect.orDie)
                    }
                  }),
                ),
              )

              yield* Queue.end(audioQueue)
              yield* Fiber.join(transcriptionFiber)
            }).pipe(
              Effect.catch((cause: CliError) => {
                config.diagnostics?.sttFailure(cause.message)
                config.diagnostics?.injectionFailure(cause.message)
                return Console.log(`[wakeword-transcribe] ${cause.message}`)
              }),
              Effect.ensuring(Ref.set(isTranscribingRef, false)),
            )

            yield* Effect.forkIn(triggerEffect, outerScope)
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
    }),
  )
