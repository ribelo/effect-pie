import { Console, Effect, Option, Ref, Stream } from "effect"
import { Command, Flag } from "effect/unstable/cli"
import { validateWakewordAssets, type WakewordAssetError } from "../wakeword/assets.js"
import { createWakewordTelemetryStream } from "../wakeword/live.js"
import { loadWakewordModelSessions, type WakewordRuntimeError } from "../wakeword/onnx.js"
import { makeWakewordPipeline, type WakewordPipelineError } from "../wakeword/pipeline.js"
import { createWakewordTriggerMachine } from "../wakeword/trigger.js"
import { PulseAudioClient } from "../pulse/client.js"
import { makePcmRecordOptions } from "../pulse/defs.js"
import {
  CliError,
  optionalPositiveIntegerFlag,
  optionalBoundedFloatFlag,
  optionalSourceFlag,
  positiveIntegerFlag,
} from "./shared.js"
import {
  readDetectionTuningSnapshot,
  type WakewordDetectionTuningSnapshot,
} from "../wakeword/tuning.js"
import { detectionTuningPathFor } from "./wakewordHelpers.js"

export const wakewordCommand = Command.make(
  "wakeword",
  {
    duration: positiveIntegerFlag("duration", "How long to listen for wakeword events", 20),
    threshold: optionalBoundedFloatFlag("threshold", "Trigger threshold (0.0 to 1.0)", 0, 1),
    smoothingWindow: optionalPositiveIntegerFlag(
      "smoothing-window",
      "Smoothing window size in frames",
    ),
    consecutiveFrames: optionalPositiveIntegerFlag(
      "consecutive-frames",
      "Minimum smoothed frames over threshold before trigger",
    ),
    cooldownMs: optionalPositiveIntegerFlag(
      "cooldown-ms",
      "Cooldown after trigger in milliseconds",
    ),
    noAutoTune: Flag.boolean("no-auto-tune").pipe(
      Flag.withDescription(
        "Disable loading saved tuning from $XDG_CONFIG_HOME/pie/wakeword/<model>/detection-tuning.json",
      ),
    ),
    scoreEvery: positiveIntegerFlag(
      "score-every",
      "Print score snapshots every N scored frames",
      5,
    ),
    fragmentSize: positiveIntegerFlag("fragment-size", "PulseAudio fragment size in bytes", 1024),
    source: optionalSourceFlag,
    assetRoot: Flag.string("asset-root").pipe(
      Flag.optional,
      Flag.withDescription("Override wakeword asset root directory"),
    ),
    models: Flag.string("models").pipe(
      Flag.optional,
      Flag.withDescription("Comma-separated wakeword model file names"),
    ),
  },
  (config) =>
    Effect.scoped(
      Effect.gen(function* () {
        const wakewordModels = Option.isSome(config.models)
          ? config.models.value
              .split(",")
              .map((entry) => entry.trim())
              .filter((entry) => entry.length > 0)
          : undefined

        const assetOptions: {
          rootDir?: string
          wakewordModels?: ReadonlyArray<string>
        } = {}

        if (Option.isSome(config.assetRoot)) {
          assetOptions.rootDir = config.assetRoot.value
        }

        if (wakewordModels !== undefined && wakewordModels.length > 0) {
          assetOptions.wakewordModels = wakewordModels
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

        const tuningSnapshots = config.noAutoTune
          ? new Map<string, WakewordDetectionTuningSnapshot>()
          : yield* Effect.gen(function* () {
              const snapshots = new Map<string, WakewordDetectionTuningSnapshot>()
              for (const modelName of modelNames) {
                const tuningPath = detectionTuningPathFor(modelName)
                const snapshot = yield* readDetectionTuningSnapshot(tuningPath)
                if (snapshot !== undefined) {
                  snapshots.set(modelName, snapshot)
                  yield* Console.log(`Loaded wakeword tuning for ${modelName} from ${tuningPath}`)
                }
              }
              return snapshots
            })

        const firstModelName = modelNames[0]
        const firstTuning =
          firstModelName !== undefined ? tuningSnapshots.get(firstModelName) : undefined

        const resolvedThreshold = Option.isSome(config.threshold)
          ? config.threshold.value
          : (firstTuning?.trigger.threshold ?? 0.5)
        const resolvedSmoothingWindow = Option.isSome(config.smoothingWindow)
          ? config.smoothingWindow.value
          : (firstTuning?.trigger.smoothingWindow ?? 4)
        const resolvedConsecutiveFrames = Option.isSome(config.consecutiveFrames)
          ? config.consecutiveFrames.value
          : (firstTuning?.trigger.consecutiveFrames ?? 3)
        const resolvedCooldownMs = Option.isSome(config.cooldownMs)
          ? config.cooldownMs.value
          : (firstTuning?.trigger.cooldownMs ?? 1500)

        yield* Console.log(
          `Trigger tuning: threshold=${resolvedThreshold.toFixed(3)} smoothing_window=${resolvedSmoothingWindow} consecutive_frames=${resolvedConsecutiveFrames} cooldown_ms=${resolvedCooldownMs}`,
        )

        const triggerMachine = createWakewordTriggerMachine({
          threshold: resolvedThreshold,
          smoothingWindow: resolvedSmoothingWindow,
          consecutiveFrames: resolvedConsecutiveFrames,
          cooldownMs: resolvedCooldownMs,
        })

        const scoreCounter = yield* Ref.make(0)

        yield* Console.log(
          `Listening for wakewords (${Object.keys(assets.wakewordModelPaths).join(", ")}) for ${config.duration}s...`,
        )

        const resolvedSourceName = yield* Effect.gen(function* () {
          if (Option.isSome(config.source)) {
            return config.source.value
          }

          const client = yield* PulseAudioClient
          const serverInfo = yield* client.getServerInfo

          if (serverInfo.defaultSource === null || serverInfo.defaultSource.length === 0) {
            return yield* new CliError({
              message: "PulseAudio did not return a default capture source",
            })
          }

          return serverInfo.defaultSource
        })

        const wakewordRecordOptions = makePcmRecordOptions({
          rate: 16_000,
          fragmentSize: config.fragmentSize,
          sourceName: resolvedSourceName,
        })

        yield* Console.log(
          `Wakeword source: ${wakewordRecordOptions.sourceName ?? "@DEFAULT_SOURCE@"}`,
        )

        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* createWakewordTelemetryStream({
              pipeline,
              trigger: triggerMachine,
              recordStream: wakewordRecordOptions,
            }).pipe(
              Stream.runForEach((event) =>
                Effect.gen(function* () {
                  if (event.type === "score") {
                    const trackedModels = Object.keys(event.frame.scores)
                    if (trackedModels.length === 0) {
                      return
                    }

                    const frameIndex = yield* Ref.updateAndGet(scoreCounter, (count) => count + 1)
                    if (frameIndex % config.scoreEvery !== 0) {
                      return
                    }

                    const formattedScores = Object.entries(event.frame.scores)
                      .map(([model, score]) => `${model}=${score.toFixed(6)}`)
                      .join(" ")

                    yield* Console.log(
                      `[score t=${event.frame.timestampMs.toFixed(0)}ms] ${formattedScores}`,
                    )
                    return
                  }

                  yield* Console.log(
                    `[trigger t=${event.event.timestampMs.toFixed(0)}ms] ${event.event.model} score=${event.event.score.toFixed(3)} raw=${event.event.rawScore.toFixed(3)}`,
                  )
                }),
              ),
              Effect.forkScoped,
            )

            yield* Effect.sleep(`${config.duration} seconds`)
          }),
        )
        yield* Console.log("Wakeword session complete")
      }),
    ),
).pipe(Command.withDescription("Run live openWakeWord detection on PulseAudio input"))
