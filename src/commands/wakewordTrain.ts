import { Console, Effect, Option, Ref } from "effect"
import { Command, Flag } from "effect/unstable/cli"
import { validateWakewordAssets, type WakewordAssetError } from "../wakeword/assets.js"
import { loadWakewordFeatureSessions, type WakewordRuntimeError } from "../wakeword/onnx.js"
import {
  initializeWakewordTrainingWorkspace,
  loadSavedWavClips,
  makeWakewordTrainingPlan,
  nextWavPath,
  registerWakewordModelInManifest,
  saveTrainedWakewordModel,
  sortedWavPaths,
  trainLinearWakewordModel,
  validateMinimumClips,
  WakewordTrainingError,
  writePcmWavFile,
} from "../wakeword/training.js"
import { PulseAudioClient } from "../pulse/client.js"
import { pcmPeak, pcmRms } from "../audio/pcm.js"
import {
  boundedFloatFlag,
  clamp,
  NoSpeechDetectedError,
  optionalBoundedFloatFlag,
  optionalPositiveIntegerFlag,
  optionalSourceFlag,
  positiveIntegerFlag,
} from "./shared.js"
import { recordPcmClip, recordVoiceActivatedClip } from "./audioCapture.js"
import {
  calibrationPathFor,
  readCalibrationSnapshot,
  resolveTrainingSource,
  runAutoCalibration,
  writeCalibrationSnapshot,
} from "./wakewordHelpers.js"
import { runPostTrainValidationAndTuning } from "../wakeword/tuning.js"

export const wakewordTrainCommand = Command.make(
  "wakeword-train",
  {
    name: Flag.string("name").pipe(
      Flag.withDescription("Custom wakeword name (model file will be <name>.json)"),
    ),
    positiveCount: positiveIntegerFlag("positive-count", "Number of positive clips to collect", 12),
    negativeCount: positiveIntegerFlag("negative-count", "Number of negative clips to collect", 20),
    clipSeconds: boundedFloatFlag("clip-seconds", "Clip duration in seconds", 1.2, 0.4, 6),
    gapMs: positiveIntegerFlag("gap-ms", "Pause between clips in milliseconds", 600),
    fragmentSize: positiveIntegerFlag("fragment-size", "PulseAudio fragment size in bytes", 1024),
    maxWaitSeconds: optionalPositiveIntegerFlag(
      "max-wait-seconds",
      "Max seconds to wait for speech before retry (auto by default)",
    ),
    retryLimit: positiveIntegerFlag(
      "retry-limit",
      "Retries per positive clip when no speech is detected",
      3,
    ),
    speechRms: optionalBoundedFloatFlag(
      "speech-rms",
      "RMS threshold for speech detection (0.001-0.2, auto by default)",
      0.001,
      0.2,
    ),
    speechChunks: optionalPositiveIntegerFlag(
      "speech-chunks",
      "Consecutive chunks above threshold to start clip (auto by default)",
    ),
    preRollMs: optionalPositiveIntegerFlag(
      "pre-roll-ms",
      "Audio to include before speech trigger in milliseconds (auto by default)",
    ),
    noAutoCalibrate: Flag.boolean("no-auto-calibrate").pipe(
      Flag.withDescription("Disable automatic source and RMS calibration"),
    ),
    recalibrate: Flag.boolean("recalibrate").pipe(
      Flag.withDescription("Ignore saved calibration snapshot and calibrate again"),
    ),
    source: optionalSourceFlag,
    assetRoot: Flag.string("asset-root").pipe(
      Flag.optional,
      Flag.withDescription(
        "Root openWakeWord asset directory (default: $XDG_DATA_HOME/pie/openwakeword)",
      ),
    ),
    datasetRoot: Flag.string("dataset-root").pipe(
      Flag.optional,
      Flag.withDescription("Override training dataset root directory"),
    ),
    outputDir: Flag.string("output-dir").pipe(
      Flag.optional,
      Flag.withDescription("Override trained wakeword model output directory"),
    ),
    captureNegativesOnly: Flag.boolean("capture-negatives-only").pipe(
      Flag.withDescription("Append negative clips to saved dataset without training"),
    ),
    trainOnly: Flag.boolean("train-only").pipe(
      Flag.withDescription("Train from saved clips without capturing new audio"),
    ),
    noTuning: Flag.boolean("no-tuning").pipe(
      Flag.withDescription("Skip writing detection-tuning.json after training"),
    ),
    register: Flag.boolean("register").pipe(
      Flag.withDescription(
        "Add generated model filename to $XDG_DATA_HOME/pie/openwakeword/manifest.json",
      ),
    ),
  },
  (config) =>
    Effect.scoped(
      Effect.gen(function* () {
        if (config.captureNegativesOnly && config.trainOnly) {
          return yield* new WakewordTrainingError({
            message: "--capture-negatives-only and --train-only are mutually exclusive",
          })
        }

        const trainingOptions: {
          name: string
          assetRootDir?: string
          datasetRootDir?: string
          outputDir?: string
        } = {
          name: config.name,
        }

        if (Option.isSome(config.assetRoot)) {
          trainingOptions.assetRootDir = config.assetRoot.value
        }

        if (Option.isSome(config.datasetRoot)) {
          trainingOptions.datasetRootDir = config.datasetRoot.value
        }

        if (Option.isSome(config.outputDir)) {
          trainingOptions.outputDir = config.outputDir.value
        }

        const plan = yield* makeWakewordTrainingPlan(trainingOptions)

        yield* initializeWakewordTrainingWorkspace(plan)

        const assets = yield* validateWakewordAssets({
          rootDir: plan.assetRootDir,
          validateWakewordModels: false,
        }).pipe(
          Effect.mapError(
            (cause: WakewordAssetError) =>
              new WakewordTrainingError({
                message: `Wakeword feature assets are invalid: ${cause.message}`,
                cause,
              }),
          ),
        )

        const featureSessions = yield* loadWakewordFeatureSessions(assets).pipe(
          Effect.mapError(
            (cause: WakewordRuntimeError) =>
              new WakewordTrainingError({
                message: `Failed to initialize feature models: ${cause.message}`,
                cause,
              }),
          ),
        )

        yield* Effect.addFinalizer(() => featureSessions.dispose)

        const requestedSourceName = Option.isSome(config.source) ? config.source.value : undefined
        const autoCalibrate = !config.noAutoCalibrate
        const calibrationPath = calibrationPathFor(plan.modelName)

        if (config.trainOnly) {
          yield* Console.log(`Train-only mode: loading saved clips for '${plan.modelName}'`)

          yield* validateMinimumClips({ dir: plan.positiveDir, label: "positive", minimum: 3 })
          yield* validateMinimumClips({ dir: plan.negativeDir, label: "negative", minimum: 3 })

          const positiveClips = yield* loadSavedWavClips(plan.positiveDir)
          const negativeClips = yield* loadSavedWavClips(plan.negativeDir)

          yield* Console.log(
            `Loaded ${positiveClips.length} positive, ${negativeClips.length} negative clips`,
          )

          const model = yield* trainLinearWakewordModel(featureSessions, {
            positiveClips,
            negativeClips,
          })

          yield* saveTrainedWakewordModel(plan.outputModelPath, model)

          const calibrationSnapshot = yield* readCalibrationSnapshot(calibrationPath).pipe(
            Effect.mapError(
              (cause) =>
                new WakewordTrainingError({
                  message: `Failed to read calibration snapshot: ${cause.message}`,
                  cause,
                }),
            ),
          )
          const sourceName = calibrationSnapshot?.sourceName ?? "unknown"

          yield* runPostTrainValidationAndTuning({
            featureSessions,
            plan,
            noTuning: config.noTuning,
            sourceName,
          })

          let manifestMessage = "Manifest unchanged"
          if (config.register) {
            const added = yield* registerWakewordModelInManifest(
              plan.manifestPath,
              plan.outputModelFileName,
            )
            manifestMessage = added
              ? `Registered ${plan.outputModelFileName} in ${plan.manifestPath}`
              : `${plan.outputModelFileName} already present in ${plan.manifestPath}`
          }

          yield* Console.log(`Training complete for '${plan.modelName}'`)
          yield* Console.log(`Model saved to: ${plan.outputModelPath}`)
          yield* Console.log(
            `Training metrics: positive_mean=${model.metrics.positiveMean.toFixed(3)} negative_mean=${model.metrics.negativeMean.toFixed(3)}`,
          )
          yield* Console.log(manifestMessage)
          return
        }

        const client = yield* PulseAudioClient

        const sourceNameResult = yield* Effect.gen(function* () {
          const serverInfo = yield* client.getServerInfo
          const availableSources = yield* client.listSources

          const selectedSourceName = yield* resolveTrainingSource({
            requestedSourceName,
            defaultSourceName: serverInfo.defaultSource,
            availableSources,
            fragmentSize: config.fragmentSize,
            autoCalibrate,
          })

          const wakePhrase = plan.modelName.replace(/_/g, " ")

          const savedCalibration =
            autoCalibrate && !config.recalibrate
              ? yield* readCalibrationSnapshot(calibrationPath).pipe(
                  Effect.mapError(
                    (cause) =>
                      new WakewordTrainingError({
                        message: `Failed to read calibration snapshot: ${cause.message}`,
                        cause,
                      }),
                  ),
                )
              : undefined

          const calibrationResult =
            autoCalibrate &&
            (savedCalibration === undefined || savedCalibration.sourceName !== selectedSourceName)
              ? yield* runAutoCalibration({
                  sourceName: selectedSourceName,
                  fragmentSize: config.fragmentSize,
                  wakePhrase,
                })
              : savedCalibration === undefined
                ? undefined
                : {
                    sourceName: savedCalibration.sourceName,
                    noiseRmsP95: savedCalibration.noiseRmsP95,
                    speechRmsP50: savedCalibration.speechRmsP50,
                    speechRmsP80: savedCalibration.speechRmsP80,
                    resolvedSpeechRms: savedCalibration.resolved.speechRms,
                    resolvedSpeechChunks: savedCalibration.resolved.speechChunks,
                    resolvedPreRollMs: savedCalibration.resolved.preRollMs,
                    resolvedMaxWaitSeconds: savedCalibration.resolved.maxWaitSeconds,
                  }

          if (
            autoCalibrate &&
            calibrationResult !== undefined &&
            (savedCalibration === undefined || savedCalibration.sourceName !== selectedSourceName)
          ) {
            yield* writeCalibrationSnapshot(calibrationPath, {
              schemaVersion: 1,
              createdAt: new Date().toISOString(),
              sourceName: calibrationResult.sourceName,
              noiseRmsP95: calibrationResult.noiseRmsP95,
              speechRmsP50: calibrationResult.speechRmsP50,
              speechRmsP80: calibrationResult.speechRmsP80,
              resolved: {
                speechRms: calibrationResult.resolvedSpeechRms,
                speechChunks: calibrationResult.resolvedSpeechChunks,
                preRollMs: calibrationResult.resolvedPreRollMs,
                maxWaitSeconds: calibrationResult.resolvedMaxWaitSeconds,
              },
            })
          }

          const resolvedSpeechRms = Option.isSome(config.speechRms)
            ? config.speechRms.value
            : (calibrationResult?.resolvedSpeechRms ?? 0.015)
          const resolvedSpeechChunks = Option.isSome(config.speechChunks)
            ? config.speechChunks.value
            : (calibrationResult?.resolvedSpeechChunks ?? 2)
          const resolvedPreRollMs = Option.isSome(config.preRollMs)
            ? config.preRollMs.value
            : (calibrationResult?.resolvedPreRollMs ?? 250)
          const resolvedMaxWaitSeconds = Option.isSome(config.maxWaitSeconds)
            ? config.maxWaitSeconds.value
            : (calibrationResult?.resolvedMaxWaitSeconds ?? 8)
          const noiseFloorRms =
            calibrationResult?.noiseRmsP95 ?? Math.max(0.0005, resolvedSpeechRms * 0.2)

          yield* Console.log(`Training capture source: ${selectedSourceName}`)

          if (
            savedCalibration !== undefined &&
            savedCalibration.sourceName === selectedSourceName
          ) {
            yield* Console.log(`Loaded calibration snapshot: ${calibrationPath}`)
          } else if (calibrationResult !== undefined) {
            yield* Console.log(`Saved calibration snapshot: ${calibrationPath}`)
          }

          yield* Console.log(
            `Capture tuning: speech_rms=${resolvedSpeechRms.toFixed(4)} speech_chunks=${resolvedSpeechChunks} pre_roll_ms=${resolvedPreRollMs} max_wait_seconds=${resolvedMaxWaitSeconds}`,
          )

          const speechRmsRef = yield* Ref.make(resolvedSpeechRms)

          if (!config.captureNegativesOnly) {
            yield* Console.log(`Capturing 1 silence clip (stay silent)`)
            yield* Console.log(`[silence 1/1] Stay silent for ${config.clipSeconds}s`)
            yield* Effect.sleep("300 millis")

            const silenceClip = yield* recordPcmClip({
              durationSeconds: config.clipSeconds,
              fragmentSize: config.fragmentSize,
              sampleRate: 16_000,
              channels: 1,
              sourceName: selectedSourceName,
            })

            const silencePath = yield* nextWavPath(plan.silenceDir, "silence")
            yield* writePcmWavFile(silencePath, silenceClip)
            yield* Console.log(`[silence 1/1] saved`)
            yield* Effect.sleep(`${config.gapMs} millis`)

            yield* Console.log(
              `Collecting ${config.positiveCount} positive clips for '${plan.modelName}'`,
            )
            for (let index = 0; index < config.positiveCount; index += 1) {
              const clipNumber = index + 1

              const collectPositiveAttempt = (
                attempt: number,
              ): Effect.Effect<Uint8Array, Error, PulseAudioClient> =>
                Effect.gen(function* () {
                  const currentSpeechRms = yield* Ref.get(speechRmsRef)

                  yield* Console.log(
                    `[positive ${clipNumber}/${config.positiveCount} attempt ${attempt}/${config.retryLimit}] Say '${wakePhrase}' (waiting for speech, rms=${currentSpeechRms.toFixed(4)})`,
                  )

                  const clip = yield* recordVoiceActivatedClip({
                    clipSeconds: config.clipSeconds,
                    maxWaitSeconds: resolvedMaxWaitSeconds,
                    speechRmsThreshold: currentSpeechRms,
                    minActiveChunks: resolvedSpeechChunks,
                    preRollMs: resolvedPreRollMs,
                    fragmentSize: config.fragmentSize,
                    sampleRate: 16_000,
                    channels: 1,
                    sourceName: selectedSourceName,
                  })

                  const clipRms = pcmRms(clip)
                  const clipPeak = pcmPeak(clip)
                  const minClipRms = Math.max(noiseFloorRms * 2.5, currentSpeechRms * 0.9, 0.003)
                  const minClipPeak = Math.max(minClipRms * 3, 0.01)

                  if (clipRms < minClipRms || clipPeak < minClipPeak) {
                    return yield* new NoSpeechDetectedError({
                      message: `Captured clip is too quiet (rms ${clipRms.toFixed(4)}, peak ${clipPeak.toFixed(4)}; expected at least rms ${minClipRms.toFixed(4)}, peak ${minClipPeak.toFixed(4)})`,
                      observedMaxRms: clipRms,
                      threshold: minClipRms,
                    })
                  }

                  return clip
                }).pipe(
                  Effect.catchIf(
                    (error): error is NoSpeechDetectedError =>
                      error instanceof NoSpeechDetectedError,
                    (error) =>
                      Effect.gen(function* () {
                        const speechRmsLocked = Option.isSome(config.speechRms)
                        const currentSpeechRms = yield* Ref.get(speechRmsRef)
                        const floor = Math.max(0.001, noiseFloorRms * 1.5)
                        const suggestedThreshold = Math.max(floor, error.observedMaxRms * 0.85)

                        if (!speechRmsLocked) {
                          const loweredThreshold = clamp(
                            Math.min(currentSpeechRms * 0.9, suggestedThreshold),
                            floor,
                            0.2,
                          )

                          if (loweredThreshold < currentSpeechRms) {
                            yield* Ref.set(speechRmsRef, loweredThreshold)
                            yield* Console.log(
                              `[positive ${clipNumber}/${config.positiveCount}] Auto-adjusted speech-rms ${currentSpeechRms.toFixed(4)} -> ${loweredThreshold.toFixed(4)}`,
                            )
                          }
                        }

                        if (attempt >= config.retryLimit) {
                          const effectiveSpeechRms = yield* Ref.get(speechRmsRef)
                          return yield* new WakewordTrainingError({
                            message: `[positive ${clipNumber}/${config.positiveCount}] ${error.message}. Final speech-rms was ${effectiveSpeechRms.toFixed(4)}. Run 'pie meter --source ${selectedSourceName}' to inspect live levels.`,
                          })
                        }

                        const nextSpeechRms = yield* Ref.get(speechRmsRef)

                        return yield* Console.log(
                          `[positive ${clipNumber}/${config.positiveCount}] ${error.message}. Retrying... (next speech-rms ${nextSpeechRms.toFixed(4)})`,
                        ).pipe(Effect.andThen(collectPositiveAttempt(attempt + 1)))
                      }),
                  ),
                )

              const clip = yield* collectPositiveAttempt(1)
              yield* Console.log(
                `[positive ${clipNumber}/${config.positiveCount}] accepted clip rms=${pcmRms(clip).toFixed(4)} peak=${pcmPeak(clip).toFixed(4)}`,
              )

              const outputPath = yield* nextWavPath(plan.positiveDir, "positive")
              yield* writePcmWavFile(outputPath, clip)
              yield* Effect.sleep(`${config.gapMs} millis`)
            }
          }

          yield* Console.log(
            `Collecting ${config.negativeCount} negative clips (do not say wake phrase)`,
          )
          for (let index = 0; index < config.negativeCount; index += 1) {
            const clipNumber = index + 1
            yield* Console.log(
              `[negative ${clipNumber}/${config.negativeCount}] Speak anything else or stay silent`,
            )
            yield* Effect.sleep("300 millis")

            const clip = yield* recordPcmClip({
              durationSeconds: config.clipSeconds,
              fragmentSize: config.fragmentSize,
              sampleRate: 16_000,
              channels: 1,
              sourceName: selectedSourceName,
            })

            const outputPath = yield* nextWavPath(plan.negativeDir, "negative")
            yield* writePcmWavFile(outputPath, clip)
            yield* Effect.sleep(`${config.gapMs} millis`)
          }

          if (config.captureNegativesOnly) {
            const positivePaths = yield* sortedWavPaths(plan.positiveDir)
            const negativePaths = yield* sortedWavPaths(plan.negativeDir)
            const silencePaths = yield* sortedWavPaths(plan.silenceDir)

            yield* Console.log(
              `Dataset counts: positive=${positivePaths.length} negative=${negativePaths.length} silence=${silencePaths.length}`,
            )
            yield* Console.log(
              `Negative clips appended. Retrain with: pie wakeword-train --name ${plan.modelName} --train-only`,
            )
            return selectedSourceName
          }

          return selectedSourceName
        })

        const selectedSourceName = sourceNameResult

        if (config.captureNegativesOnly) {
          return
        }

        yield* validateMinimumClips({ dir: plan.positiveDir, label: "positive", minimum: 3 })
        yield* validateMinimumClips({ dir: plan.negativeDir, label: "negative", minimum: 3 })

        const positiveClips = yield* loadSavedWavClips(plan.positiveDir)
        const negativeClips = yield* loadSavedWavClips(plan.negativeDir)

        yield* Console.log(
          `Training from ${positiveClips.length} positive, ${negativeClips.length} negative saved clips`,
        )

        const model = yield* trainLinearWakewordModel(featureSessions, {
          positiveClips,
          negativeClips,
        })

        yield* saveTrainedWakewordModel(plan.outputModelPath, model)

        yield* runPostTrainValidationAndTuning({
          featureSessions,
          plan,
          noTuning: config.noTuning,
          sourceName: selectedSourceName,
        })

        let manifestMessage = "Manifest unchanged"
        if (config.register) {
          const added = yield* registerWakewordModelInManifest(
            plan.manifestPath,
            plan.outputModelFileName,
          )
          manifestMessage = added
            ? `Registered ${plan.outputModelFileName} in ${plan.manifestPath}`
            : `${plan.outputModelFileName} already present in ${plan.manifestPath}`
        }

        yield* Console.log(`Training complete for '${plan.modelName}'`)
        yield* Console.log(`Positive clips saved in: ${plan.positiveDir}`)
        yield* Console.log(`Negative clips saved in: ${plan.negativeDir}`)
        yield* Console.log(`Silence clips saved in: ${plan.silenceDir}`)
        yield* Console.log(`Model saved to: ${plan.outputModelPath}`)
        yield* Console.log(
          `Training metrics: positive_mean=${model.metrics.positiveMean.toFixed(3)} negative_mean=${model.metrics.negativeMean.toFixed(3)}`,
        )
        yield* Console.log(manifestMessage)
        yield* Console.log(
          `Verify with: pie wakeword --models ${plan.outputModelFileName} --duration 20 --threshold 0.5`,
        )
      }),
    ),
).pipe(
  Command.withDescription(
    "Collect positive/negative clips, train a wakeword model, save it, and optionally register in manifest",
  ),
)
