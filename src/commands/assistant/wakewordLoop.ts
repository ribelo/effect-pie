import { Console, Effect, Ref, Stream } from "effect"

import type { PulseAudioClient } from "../../pulse/client.js"
import { makePcmRecordOptions } from "../../pulse/defs.js"
import { validateWakewordAssets, type WakewordAssetError } from "../../wakeword/assets.js"
import { createWakewordTelemetryStream } from "../../wakeword/live.js"
import { loadWakewordModelSessions, type WakewordRuntimeError } from "../../wakeword/onnx.js"
import { makeWakewordPipeline, type WakewordPipelineError } from "../../wakeword/pipeline.js"
import { createWakewordTriggerMachine } from "../../wakeword/trigger.js"
import type { TextInjectionBackendService } from "../../input/textInjection.js"
import type { DesktopSession } from "../../desktop/session.js"
import type { Niri } from "../../niri/niri.js"
import { recordPcmUntilTrailingSilence } from "../audioCapture.js"
import {
  calibrationPathFor,
  detectionTuningPathFor,
  readCalibrationSnapshot,
} from "../wakewordHelpers.js"
import { readDetectionTuningSnapshot, type WakewordSnapshotError } from "../../wakeword/tuning.js"
import type { SttService } from "../../stt/service.js"
import { classifyStreamingError, makeStreamedSttDispatch } from "../../stt/streamedDispatch.js"
import type { SttRuntimeConfig } from "../../stt/config.js"
import { CliError } from "../shared.js"
import {
  DEFAULT_ASSISTANT_WAKEWORD_MODEL_FILE,
  DEFAULT_ASSISTANT_SAMPLE_RATE,
  DEFAULT_ASSISTANT_WAKEWORD_FRAGMENT_SIZE,
  DEFAULT_ASSISTANT_PTT_FRAGMENT_SIZE,
  resolveWakewordSpeechStartTimeoutSeconds,
} from "./constants.js"
import { RecordingCoordinator } from "./coordinator.js"

const normalizeWakewordModelName = (modelName: string): string =>
  modelName.endsWith(".json") ? modelName.slice(0, -".json".length) : modelName

export const runAssistantWakewordTranscribeLoop = (config: {
  readonly sourceName: string
  readonly sttConfig: SttRuntimeConfig
}): Effect.Effect<
  void,
  CliError,
  | PulseAudioClient
  | DesktopSession
  | Niri
  | TextInjectionBackendService
  | SttService
  | RecordingCoordinator
> =>
  Effect.scoped(
    Effect.gen(function* () {
      const coordinator = yield* RecordingCoordinator
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
            const daemonState = yield* coordinator.snapshot
            if (!daemonState.enabled) {
              return
            }

            if (event.type !== "trigger" || event.event.model !== selectedModelName) {
              return
            }

            const alreadyTranscribing = yield* Ref.get(isTranscribingRef)
            if (alreadyTranscribing) {
              return
            }

            yield* Ref.set(isTranscribingRef, true)

            const triggerEffect = Effect.gen(function* () {
              const dictationSilenceSeconds = config.sttConfig.wakewordDictationSilenceSeconds
              const dictationMaxSeconds = config.sttConfig.wakewordDictationMaxSeconds
              const dictationSpeechStartTimeoutSeconds = resolveWakewordSpeechStartTimeoutSeconds({
                silenceSeconds: dictationSilenceSeconds,
                maxSeconds: dictationMaxSeconds,
              })
              const dictationSpeechRmsThreshold =
                calibrationSnapshot?.resolved.speechRms ??
                config.sttConfig.wakewordDictationSpeechRmsThreshold

              yield* Effect.logInfo("Wakeword trigger detected; dictation capture started").pipe(
                Effect.annotateLogs({
                  "wakeword.model": selectedModelName,
                  "wakeword.confidence": event.event.score,
                  "wakeword.silence_seconds": dictationSilenceSeconds,
                  "wakeword.max_seconds": dictationMaxSeconds,
                }),
              )

              const result = yield* coordinator.tryStart("wakeword")
              if (result["_tag"] === "Busy") {
                yield* Effect.logWarning("Wakeword ignored: another mode is active").pipe(
                  Effect.annotateLogs({ "wakeword.active_mode": result.activeMode }),
                )
                return
              }
              if (result["_tag"] === "Disabled") {
                yield* Effect.logWarning("Wakeword ignored: PIE is disabled")
                return
              }

              const dispatch = yield* makeStreamedSttDispatch({
                operation: {
                  kind: "transcribe",
                  model: config.sttConfig.transcriptionModel,
                  language: config.sttConfig.transcriptionLanguage,
                  promptTemplate: config.sttConfig.transcriptionPrompt,
                },
                sampleRate: DEFAULT_ASSISTANT_SAMPLE_RATE,
                logPrefix: "wakeword-transcribe",
              })

              yield* recordPcmUntilTrailingSilence({
                silenceSeconds: dictationSilenceSeconds,
                maxSeconds: dictationMaxSeconds,
                speechStartTimeoutSeconds: dictationSpeechStartTimeoutSeconds,
                speechRmsThreshold: dictationSpeechRmsThreshold,
                fragmentSize: DEFAULT_ASSISTANT_PTT_FRAGMENT_SIZE,
                sampleRate: DEFAULT_ASSISTANT_SAMPLE_RATE,
                channels: 1,
                sourceName: config.sourceName,
                onChunk: dispatch.offer,
              }).pipe(
                Effect.mapError(
                  (cause) =>
                    new CliError({
                      message: "Failed to capture wakeword dictation clip",
                      cause,
                    }),
                ),
                Effect.tapError(() => dispatch.cancel),
                Effect.onExit(() =>
                  Effect.gen(function* () {
                    const snapshot = yield* coordinator.snapshot
                    if (snapshot.mode === "wakeword") {
                      yield* coordinator.stop("wakeword")
                    }
                  }),
                ),
              )

              yield* dispatch.finish.pipe(
                Effect.mapError((cause) => {
                  const classified = classifyStreamingError(cause, "Wakeword transcription failed")
                  return new CliError({
                    message: classified.message,
                    cause,
                  })
                }),
              )
            }).pipe(
              Effect.catch((cause: CliError) =>
                Effect.logError("Wakeword transcription failed").pipe(
                  Effect.annotateLogs({ "wakeword.error": cause.message }),
                ),
              ),
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
