import { Console, Effect, Option, Stream } from "effect"
import { Command, Flag } from "effect/unstable/cli"
import * as path from "node:path"
import { validateWakewordAssets, type WakewordAssetError } from "../wakeword/assets.js"
import {
  loadWakewordModelSessions,
  type WakewordModelSessions,
  type WakewordRuntimeError,
} from "../wakeword/onnx.js"
import { makeWakewordPipeline, type WakewordPipelineError } from "../wakeword/pipeline.js"
import { PulseAudioClient } from "../pulse/client.js"
import { makePcmRecordOptions } from "../pulse/defs.js"
import { createRecordStream } from "../pulse/stream.js"
import { WakewordTrainingError } from "../wakeword/training.js"
import {
  CliError,
  optionalPositiveIntegerFlag,
  optionalSourceFlag,
  positiveIntegerFlag,
  waitForEnter,
} from "./shared.js"
import { detectionTuningPathFor } from "./wakewordHelpers.js"
import {
  evaluateTriggerTuning,
  estimateWakePhraseCount,
  summarizeScores,
  writeDetectionTuningSnapshot,
  type CapturedScoreFrame,
} from "../wakeword/tuning.js"

const collectWakewordScoresInteractive = (config: {
  readonly startPrompt: string
  readonly stopPrompt: string
  readonly sourceName: string
  readonly fragmentSize: number
  readonly modelName: string
  readonly sessions: WakewordModelSessions
}): Effect.Effect<
  ReadonlyArray<CapturedScoreFrame>,
  WakewordTrainingError | Error,
  PulseAudioClient
> =>
  Effect.gen(function* () {
    yield* waitForEnter(config.startPrompt).pipe(
      Effect.mapError(
        (cause) =>
          new WakewordTrainingError({
            message: cause.message,
            cause,
          }),
      ),
    )

    const pipeline = yield* makeWakewordPipeline(config.sessions).pipe(
      Effect.mapError(
        (cause: WakewordPipelineError) =>
          new WakewordTrainingError({
            message: `Failed to initialize wakeword pipeline for tuning: ${cause.message}`,
          }),
      ),
    )

    const frames: Array<CapturedScoreFrame> = []
    let totalScoreFrames = 0
    const observedModelNames = new Set<string>()

    const recordOptions = makePcmRecordOptions({
      rate: 16_000,
      fragmentSize: config.fragmentSize,
      sourceName: config.sourceName,
    })

    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* createRecordStream(recordOptions).pipe(
          Stream.runForEach((chunk) =>
            Effect.gen(function* () {
              const scoreFrames = yield* pipeline.feedPcmChunk(chunk).pipe(
                Effect.mapError(
                  (cause: WakewordPipelineError) =>
                    new WakewordTrainingError({
                      message: `Wakeword pipeline failed while collecting tuning scores: ${cause.message}`,
                    }),
                ),
              )

              totalScoreFrames += scoreFrames.length

              for (const frame of scoreFrames) {
                for (const model of Object.keys(frame.scores)) {
                  observedModelNames.add(model)
                }

                const score = frame.scores[config.modelName]
                if (score !== undefined) {
                  frames.push({
                    timestampMs: frame.timestampMs,
                    score,
                  })
                }
              }
            }),
          ),
          Effect.forkScoped,
        )

        yield* waitForEnter(config.stopPrompt).pipe(
          Effect.mapError(
            (cause) =>
              new WakewordTrainingError({
                message: cause.message,
                cause,
              }),
          ),
        )
      }),
    )

    if (frames.length === 0) {
      if (totalScoreFrames === 0) {
        return yield* new CliError({
          message: "No wakeword score frames captured during tuning",
        })
      }

      const observed = [...observedModelNames].sort()
      if (observed.length > 0) {
        return yield* new CliError({
          message: `Model '${config.modelName}' produced no scores during tuning. Observed models: ${observed.join(", ")}. Use --model to tune an observed model.`,
        })
      }

      return yield* new CliError({
        message: `Model '${config.modelName}' produced no scores during tuning. This usually means the model input shape does not match current wakeword features.`,
      })
    }

    return frames
  })

export const wakewordTuneCommand = Command.make(
  "wakeword-tune",
  {
    model: Flag.string("model").pipe(
      Flag.optional,
      Flag.withDescription("Wakeword model file to tune (for example: ok_pie.json)"),
    ),
    wakePhrase: Flag.string("wake-phrase").pipe(
      Flag.optional,
      Flag.withDescription(
        "Wake phrase spoken during positive calibration (defaults to model name)",
      ),
    ),
    expectedRepeats: optionalPositiveIntegerFlag(
      "expected-repeats",
      "Expected wake phrase repetitions in positive step (auto by default)",
    ),
    fragmentSize: positiveIntegerFlag("fragment-size", "PulseAudio fragment size in bytes", 1024),
    source: optionalSourceFlag,
    assetRoot: Flag.string("asset-root").pipe(
      Flag.optional,
      Flag.withDescription("Override wakeword asset root directory"),
    ),
    noSave: Flag.boolean("no-save").pipe(
      Flag.withDescription("Do not save detected trigger tuning snapshot"),
    ),
  },
  (config) =>
    Effect.scoped(
      Effect.gen(function* () {
        const requestedModel = Option.isSome(config.model) ? config.model.value : undefined

        const assetOptions: {
          rootDir?: string
          wakewordModels?: ReadonlyArray<string>
        } = {}

        if (Option.isSome(config.assetRoot)) {
          assetOptions.rootDir = config.assetRoot.value
        }

        if (requestedModel !== undefined) {
          assetOptions.wakewordModels = [requestedModel]
        }

        const assets = yield* validateWakewordAssets(assetOptions).pipe(
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

        const modelNames = Object.keys(assets.wakewordModelPaths)
        if (modelNames.length === 0) {
          return yield* new CliError({
            message: "No wakeword model is available for tuning",
          })
        }

        const preferredModelName =
          requestedModel !== undefined
            ? (modelNames.find((name) => name === requestedModel) ?? modelNames[0])
            : (modelNames.find((name) => name !== "default") ?? modelNames[0])

        if (requestedModel !== undefined && preferredModelName !== requestedModel) {
          return yield* new CliError({
            message: `Requested model '${requestedModel}' not found in available models: ${modelNames.join(", ")}`,
          })
        }

        const modelName = preferredModelName ?? "default"
        const modelPath = assets.wakewordModelPaths[modelName]

        if (modelPath === undefined) {
          return yield* new CliError({
            message: `Model '${modelName}' not found in validated asset paths. Available models: ${modelNames.join(", ")}.`,
          })
        }

        const modelFile = path.basename(modelPath)

        if (requestedModel === undefined && modelNames.length > 1) {
          yield* Console.log(
            `wakeword-tune: multiple models found (${modelNames.join(", ")}), auto-selecting '${modelName}'. Use --model to pick a specific model.`,
          )
        }

        const wakePhrase = Option.isSome(config.wakePhrase)
          ? config.wakePhrase.value
          : modelName.replace(/_/g, " ")

        const client = yield* PulseAudioClient

        const tuning = yield* Effect.gen(function* () {
          const serverInfo = yield* client.getServerInfo
          const sources = yield* client.listSources

          const resolvedSourceName = Option.isSome(config.source)
            ? config.source.value
            : serverInfo.defaultSource

          if (resolvedSourceName === null) {
            return yield* new CliError({
              message: "PulseAudio did not return a default capture source",
            })
          }

          if (!sources.some((source) => source.name === resolvedSourceName)) {
            return yield* new CliError({
              message: `Configured source '${resolvedSourceName}' not found. Run 'pie sources' and choose one source name.`,
            })
          }

          yield* Console.log(`Wakeword tuning model: ${modelName} (${modelFile})`)
          yield* Console.log(`Wakeword tuning source: ${resolvedSourceName}`)
          yield* Console.log("Tuning uses three interactive phases.")
          yield* Console.log(
            "You can capture as long as needed in each phase before pressing Enter.",
          )

          const silenceFrames = yield* collectWakewordScoresInteractive({
            sessions,
            modelName,
            sourceName: resolvedSourceName,
            fragmentSize: config.fragmentSize,
            startPrompt: [
              "Step 1/3: background baseline",
              "Stay quiet.",
              "Press Enter to start baseline capture.",
            ].join("\n"),
            stopPrompt: "Press Enter to stop baseline capture.",
          })

          const negativeFrames = yield* collectWakewordScoresInteractive({
            sessions,
            modelName,
            sourceName: resolvedSourceName,
            fragmentSize: config.fragmentSize,
            startPrompt: [
              "Step 2/3: non-wakeword speech",
              `Speak normally, but DO NOT say '${wakePhrase}'.`,
              "Press Enter to start negative capture.",
            ].join("\n"),
            stopPrompt: "Press Enter to stop negative capture.",
          })

          const positiveFrames = yield* collectWakewordScoresInteractive({
            sessions,
            modelName,
            sourceName: resolvedSourceName,
            fragmentSize: config.fragmentSize,
            startPrompt: [
              "Step 3/3: wakeword positives",
              `Say '${wakePhrase}' repeatedly, with small pauses.`,
              "Press Enter to start positive capture.",
            ].join("\n"),
            stopPrompt: "Press Enter to stop positive capture and compute tuning.",
          })

          const silenceScores = silenceFrames.map((frame) => frame.score)
          const negativeScores = negativeFrames.map((frame) => frame.score)
          const positiveScores = positiveFrames.map((frame) => frame.score)

          const silenceStats = summarizeScores(silenceScores)
          const negativeStats = summarizeScores(negativeScores)
          const positiveStats = summarizeScores(positiveScores)

          const estimatedRepeats = estimateWakePhraseCount(positiveFrames)
          const targetPositiveTriggers = Option.isSome(config.expectedRepeats)
            ? config.expectedRepeats.value
            : Math.max(1, estimatedRepeats)

          const evaluation = yield* evaluateTriggerTuning({
            modelName,
            silenceFrames,
            negativeFrames,
            positiveFrames,
            targetPositiveTriggers,
          })

          yield* Console.log(
            `Score stats: silence p99=${silenceStats.p99.toFixed(4)} negative p99=${negativeStats.p99.toFixed(4)} positive p90=${positiveStats.p90.toFixed(4)} positive max=${positiveStats.max.toFixed(4)}`,
          )
          yield* Console.log(
            `Estimated wake phrase count=${estimatedRepeats} target_triggers=${evaluation.targetPositiveTriggers}`,
          )

          return {
            sourceName: resolvedSourceName,
            silenceStats,
            negativeStats,
            positiveStats,
            estimatedRepeats,
            evaluation,
          }
        })

        const tuned = tuning.evaluation.config
        yield* Console.log(
          `Recommended trigger: threshold=${tuned.threshold.toFixed(3)} smoothing_window=${tuned.smoothingWindow} consecutive_frames=${tuned.consecutiveFrames} cooldown_ms=${tuned.cooldownMs}`,
        )
        yield* Console.log(
          `Calibration quality: positive_triggers=${tuning.evaluation.positiveTriggers}/${tuning.evaluation.targetPositiveTriggers} negative_triggers=${tuning.evaluation.negativeTriggers} silence_triggers=${tuning.evaluation.silenceTriggers}`,
        )

        if (!config.noSave) {
          const tuningPath = detectionTuningPathFor(modelName)

          yield* writeDetectionTuningSnapshot(tuningPath, {
            schemaVersion: 1,
            createdAt: new Date().toISOString(),
            sourceName: tuning.sourceName,
            modelName,
            modelFile,
            trigger: tuned,
            metrics: {
              silenceP99: tuning.silenceStats.p99,
              negativeP99: tuning.negativeStats.p99,
              positiveP90: tuning.positiveStats.p90,
              positiveEstimatedPhrases: tuning.estimatedRepeats,
              positiveTriggers: tuning.evaluation.positiveTriggers,
              negativeTriggers: tuning.evaluation.negativeTriggers,
              silenceTriggers: tuning.evaluation.silenceTriggers,
            },
          })

          yield* Console.log(`Saved tuning snapshot: ${tuningPath}`)
          yield* Console.log(
            "wakeword command will auto-load this tuning unless --no-auto-tune is set.",
          )
        }

        yield* Console.log(
          `Try now: pie wakeword --models ${modelFile} --source ${tuning.sourceName} --duration 30`,
        )
      }),
    ),
).pipe(
  Command.withDescription(
    "Interactive wakeword trigger auto-tuning (captures silence, non-wake speech, and wake phrase repeats)",
  ),
)
