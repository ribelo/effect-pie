import { Console, Effect } from "effect"
import * as Data from "effect/Data"
import * as path from "node:path"
import { mkdir as mkdirNode, readFile, writeFile as writeNodeFile } from "node:fs/promises"

import { EFFECT_PI_WAKEWORD_CONFIG_DIR } from "../paths.js"
import {
  makeWakewordPipeline,
  type WakewordPipeline,
  type WakewordPipelineError,
} from "./pipeline.js"
import { createWakewordTriggerMachine } from "./trigger.js"
import { loadSavedWavClips, WakewordTrainingError } from "./training.js"
import {
  loadLinearWakewordModel,
  type WakewordFeatureSessions,
  type WakewordRuntimeError,
} from "./onnx.js"

export type CapturedScoreFrame = {
  readonly timestampMs: number
  readonly score: number
}

export type TriggerTuningConfig = {
  readonly threshold: number
  readonly smoothingWindow: number
  readonly consecutiveFrames: number
  readonly cooldownMs: number
}

export type TriggerTuningEvaluation = {
  readonly config: TriggerTuningConfig
  readonly silenceTriggers: number
  readonly negativeTriggers: number
  readonly positiveTriggers: number
  readonly targetPositiveTriggers: number
  readonly objective: number
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value))

const percentile = (sorted: ReadonlyArray<number>, p: number): number => {
  if (sorted.length === 0) {
    return 0
  }

  const values = [...sorted].sort((a, b) => a - b)
  const index = (values.length - 1) * p
  const lower = Math.floor(index)
  const upper = Math.ceil(index)
  const weight = index - lower

  if (upper >= values.length) {
    return values[lower]!
  }

  return values[lower]! * (1 - weight) + values[upper]! * weight
}

export const summarizeScores = (
  scores: ReadonlyArray<number>,
): {
  readonly p90: number
  readonly p95: number
  readonly p99: number
  readonly max: number
  readonly mean: number
} => ({
  p90: percentile(scores, 0.9),
  p95: percentile(scores, 0.95),
  p99: percentile(scores, 0.99),
  max: scores.reduce((max, value) => (value > max ? value : max), 0),
  mean: scores.length === 0 ? 0 : scores.reduce((sum, value) => sum + value, 0) / scores.length,
})

export const countTriggersForFrames = (
  frames: ReadonlyArray<CapturedScoreFrame>,
  modelName: string,
  config: TriggerTuningConfig,
): number => {
  const machine = createWakewordTriggerMachine(config)
  let triggerCount = 0

  for (const frame of frames) {
    const events = machine.processFrame({
      timestampMs: frame.timestampMs,
      sampleIndex: Math.round((frame.timestampMs / 1000) * 16_000),
      scores: {
        [modelName]: frame.score,
      },
    })

    for (const event of events) {
      if (event.model === modelName) {
        triggerCount += 1
      }
    }
  }

  return triggerCount
}

export const estimateWakePhraseCount = (
  frames: ReadonlyArray<CapturedScoreFrame>,
  minGapMs = 700,
): number => {
  if (frames.length === 0) {
    return 0
  }

  const scores = frames.map((frame) => frame.score)
  const gate = clamp(Math.max(percentile(scores, 0.9) * 0.6, 0.12), 0.12, 0.8)

  let inRegion = false
  let peakScore = 0
  let peakTime = 0
  let lastAcceptedPeak = Number.NEGATIVE_INFINITY
  let peaks = 0

  for (const frame of frames) {
    if (frame.score >= gate) {
      inRegion = true
      if (frame.score >= peakScore) {
        peakScore = frame.score
        peakTime = frame.timestampMs
      }
      continue
    }

    if (inRegion && frame.score < gate * 0.6) {
      if (peakTime - lastAcceptedPeak >= minGapMs) {
        peaks += 1
        lastAcceptedPeak = peakTime
      }
      inRegion = false
      peakScore = 0
      peakTime = 0
    }
  }

  if (inRegion && peakTime - lastAcceptedPeak >= minGapMs) {
    peaks += 1
  }

  return peaks
}

export const candidateThresholds = (
  silenceScores: ReadonlyArray<number>,
  negativeScores: ReadonlyArray<number>,
  positiveScores: ReadonlyArray<number>,
): ReadonlyArray<number> => {
  const floor = clamp(
    Math.max(percentile(silenceScores, 0.995), percentile(negativeScores, 0.995)) + 0.02,
    0.08,
    0.85,
  )
  const ceiling = clamp(Math.max(floor + 0.12, percentile(positiveScores, 0.95)), 0.2, 0.98)

  const values = new Set<number>()

  for (let threshold = floor; threshold <= ceiling + 0.0001; threshold += 0.02) {
    values.add(Number(threshold.toFixed(3)))
  }

  for (const threshold of [0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.7]) {
    if (threshold >= floor - 0.02 && threshold <= ceiling + 0.02) {
      values.add(threshold)
    }
  }

  return [...values].sort((left, right) => left - right)
}

export const scorePcmClips = Effect.fn("pie/wakeword/tuning.scorePcmClips")(function* (config: {
  readonly clips: ReadonlyArray<Uint8Array>
  readonly pipeline: WakewordPipeline
  readonly modelName: string
}): Effect.fn.Return<ReadonlyArray<CapturedScoreFrame>, WakewordPipelineError> {
  const frames: Array<CapturedScoreFrame> = []

  for (const clip of config.clips) {
    const scoreFrames = yield* config.pipeline.feedPcmChunk(clip)
    for (const frame of scoreFrames) {
      const score = frame.scores[config.modelName]
      if (score !== undefined) {
        frames.push({
          timestampMs: frame.timestampMs,
          score,
        })
      }
    }
  }

  return frames
})

export const evaluateTriggerTuning = Effect.fn("pie/wakeword/tuning.evaluateTriggerTuning")(
  function* (config: {
    readonly modelName: string
    readonly silenceFrames: ReadonlyArray<CapturedScoreFrame>
    readonly negativeFrames: ReadonlyArray<CapturedScoreFrame>
    readonly positiveFrames: ReadonlyArray<CapturedScoreFrame>
    readonly targetPositiveTriggers: number
  }): Effect.fn.Return<TriggerTuningEvaluation, WakewordTrainingError> {
    const silenceScores = config.silenceFrames.map((frame) => frame.score)
    const negativeScores = config.negativeFrames.map((frame) => frame.score)
    const positiveScores = config.positiveFrames.map((frame) => frame.score)

    const thresholds = candidateThresholds(silenceScores, negativeScores, positiveScores)

    let best: TriggerTuningEvaluation | undefined

    for (const threshold of thresholds) {
      for (const smoothingWindow of [1, 2, 3, 4]) {
        for (const consecutiveFrames of [1, 2, 3]) {
          for (const cooldownMs of [900, 1200, 1500, 2000]) {
            const tuning: TriggerTuningConfig = {
              threshold,
              smoothingWindow,
              consecutiveFrames,
              cooldownMs,
            }

            const silenceTriggers = countTriggersForFrames(
              config.silenceFrames,
              config.modelName,
              tuning,
            )
            const negativeTriggers = countTriggersForFrames(
              config.negativeFrames,
              config.modelName,
              tuning,
            )
            const positiveTriggers = countTriggersForFrames(
              config.positiveFrames,
              config.modelName,
              tuning,
            )

            const target = Math.max(1, config.targetPositiveTriggers)
            const recall = Math.min(1, positiveTriggers / target)
            const underfire = Math.max(0, target - positiveTriggers)
            const overfire = Math.max(0, positiveTriggers - target)
            const backgroundTriggers = silenceTriggers + negativeTriggers

            const objective =
              recall * 100 -
              backgroundTriggers * 80 -
              underfire * 16 -
              overfire * 8 -
              threshold * 2 -
              (smoothingWindow - 1) * 0.6 -
              (consecutiveFrames - 1) * 0.8

            const evaluation: TriggerTuningEvaluation = {
              config: tuning,
              silenceTriggers,
              negativeTriggers,
              positiveTriggers,
              targetPositiveTriggers: target,
              objective,
            }

            if (
              best === undefined ||
              evaluation.objective > best.objective ||
              (evaluation.objective === best.objective &&
                evaluation.negativeTriggers + evaluation.silenceTriggers <
                  best.negativeTriggers + best.silenceTriggers)
            ) {
              best = evaluation
            }
          }
        }
      }
    }

    if (best === undefined) {
      return yield* new WakewordTrainingError({
        message:
          "No viable tuning configuration found. All evaluated configurations produced zero triggers.",
      })
    }

    return best
  },
)

export const runPostTrainValidationAndTuning = Effect.fn(
  "pie/wakeword/tuning.runPostTrainValidationAndTuning",
)(function* (config: {
  readonly featureSessions: WakewordFeatureSessions
  readonly plan: {
    readonly modelName: string
    readonly outputModelPath: string
    readonly positiveDir: string
    readonly negativeDir: string
    readonly silenceDir: string
  }
  readonly noTuning: boolean
  readonly sourceName: string
}): Effect.fn.Return<void, WakewordTrainingError | WakewordPipelineError | WakewordRuntimeError> {
  yield* Console.log(`Validating trained model: ${config.plan.outputModelPath}`)

  const trainedModel = yield* loadLinearWakewordModel(config.plan.outputModelPath)
  const modelSessions = {
    ...config.featureSessions,
    wakewords: {
      [config.plan.modelName]: trainedModel,
    },
  }

  const pipeline = yield* makeWakewordPipeline(modelSessions)

  const positiveClips = yield* loadSavedWavClips(config.plan.positiveDir)
  if (positiveClips.length === 0) {
    return yield* new WakewordTrainingError({
      message: "No positive clips found for validation",
    })
  }

  const positiveFrames = yield* scorePcmClips({
    clips: [positiveClips[0]!],
    pipeline,
    modelName: config.plan.modelName,
  })

  if (positiveFrames.length === 0) {
    return yield* new WakewordTrainingError({
      message: `Trained model '${config.plan.modelName}' produced no score frames from a positive clip. The model may be invalid.`,
    })
  }

  const maxPositiveScore = positiveFrames.reduce(
    (max, frame) => (frame.score > max ? frame.score : max),
    0,
  )
  yield* Console.log(
    `Validation: ${positiveFrames.length} score frames from positive clip, max_score=${maxPositiveScore.toFixed(4)}`,
  )

  if (config.noTuning) {
    yield* Console.log("Tuning persistence skipped (--no-tuning)")
    return
  }

  const silenceClips = yield* loadSavedWavClips(config.plan.silenceDir)
  const negativeClips = yield* loadSavedWavClips(config.plan.negativeDir)

  const silenceFrames = yield* scorePcmClips({
    clips: silenceClips,
    pipeline,
    modelName: config.plan.modelName,
  })
  const negativeFrames = yield* scorePcmClips({
    clips: negativeClips,
    pipeline,
    modelName: config.plan.modelName,
  })
  const allPositiveFrames = yield* scorePcmClips({
    clips: positiveClips,
    pipeline,
    modelName: config.plan.modelName,
  })

  const evaluation = yield* evaluateTriggerTuning({
    modelName: config.plan.modelName,
    silenceFrames,
    negativeFrames,
    positiveFrames: allPositiveFrames,
    targetPositiveTriggers: estimateWakePhraseCount(allPositiveFrames),
  })

  yield* writeDetectionTuningSnapshot(detectionTuningPathFor(config.plan.modelName), {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    sourceName: config.sourceName,
    modelName: config.plan.modelName,
    modelFile: `${config.plan.modelName}.json`,
    trigger: {
      threshold: evaluation.config.threshold,
      smoothingWindow: evaluation.config.smoothingWindow,
      consecutiveFrames: evaluation.config.consecutiveFrames,
      cooldownMs: evaluation.config.cooldownMs,
    },
    metrics: {
      silenceP99: percentile(
        silenceFrames.map((f) => f.score),
        0.99,
      ),
      negativeP99: percentile(
        negativeFrames.map((f) => f.score),
        0.99,
      ),
      positiveP90: percentile(
        allPositiveFrames.map((f) => f.score),
        0.9,
      ),
      positiveEstimatedPhrases: estimateWakePhraseCount(allPositiveFrames),
      positiveTriggers: evaluation.positiveTriggers,
      negativeTriggers: evaluation.negativeTriggers,
      silenceTriggers: evaluation.silenceTriggers,
    },
  })

  yield* Console.log(
    `Tuning: threshold=${evaluation.config.threshold.toFixed(3)} smoothing=${evaluation.config.smoothingWindow} consecutive=${evaluation.config.consecutiveFrames} cooldown=${evaluation.config.cooldownMs}ms`,
  )
  yield* Console.log(
    `Tuning quality: objective=${evaluation.objective.toFixed(2)} positive=${evaluation.positiveTriggers}/${evaluation.targetPositiveTriggers} background=${evaluation.silenceTriggers + evaluation.negativeTriggers}`,
  )
  yield* Console.log(`Tuning snapshot written to: ${detectionTuningPathFor(config.plan.modelName)}`)
})

export const detectionTuningPathFor = (modelName: string): string =>
  path.join(EFFECT_PI_WAKEWORD_CONFIG_DIR, modelName, "detection-tuning.json")

export const writeDetectionTuningSnapshot = Effect.fn(
  "pie/wakeword/tuning.writeDetectionTuningSnapshot",
)(function* (
  tuningPath: string,
  snapshot: WakewordDetectionTuningSnapshot,
): Effect.fn.Return<void, WakewordTrainingError> {
  yield* Effect.tryPromise({
    try: async () => {
      await mkdirNode(path.dirname(tuningPath), { recursive: true })
      await writeNodeFile(tuningPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8")
    },
    catch: (cause) =>
      new WakewordTrainingError({
        message: `Failed to write wakeword tuning snapshot at ${tuningPath}`,
        cause,
      }),
  })
})

export type WakewordDetectionTuningSnapshot = {
  readonly schemaVersion: 1
  readonly createdAt: string
  readonly sourceName: string
  readonly modelName: string
  readonly modelFile: string
  readonly trigger: {
    readonly threshold: number
    readonly smoothingWindow: number
    readonly consecutiveFrames: number
    readonly cooldownMs: number
  }
  readonly metrics: {
    readonly silenceP99: number
    readonly negativeP99: number
    readonly positiveP90: number
    readonly positiveEstimatedPhrases: number
    readonly positiveTriggers: number
    readonly negativeTriggers: number
    readonly silenceTriggers: number
  }
}

export const isWakewordDetectionTuningSnapshot = (
  value: unknown,
): value is WakewordDetectionTuningSnapshot => {
  if (!isRecord(value)) {
    return false
  }

  const snapshot = value
  const trigger = snapshot["trigger"]
  const metrics = snapshot["metrics"]

  if (!isRecord(trigger)) {
    return false
  }

  if (!isRecord(metrics)) {
    return false
  }

  const triggerRecord = trigger
  const metricsRecord = metrics

  return (
    snapshot["schemaVersion"] === 1 &&
    typeof snapshot["createdAt"] === "string" &&
    typeof snapshot["sourceName"] === "string" &&
    typeof snapshot["modelName"] === "string" &&
    typeof snapshot["modelFile"] === "string" &&
    typeof triggerRecord["threshold"] === "number" &&
    typeof triggerRecord["smoothingWindow"] === "number" &&
    typeof triggerRecord["consecutiveFrames"] === "number" &&
    typeof triggerRecord["cooldownMs"] === "number" &&
    typeof metricsRecord["silenceP99"] === "number" &&
    typeof metricsRecord["negativeP99"] === "number" &&
    typeof metricsRecord["positiveP90"] === "number" &&
    typeof metricsRecord["positiveEstimatedPhrases"] === "number" &&
    typeof metricsRecord["positiveTriggers"] === "number" &&
    typeof metricsRecord["negativeTriggers"] === "number" &&
    typeof metricsRecord["silenceTriggers"] === "number"
  )
}

export const readDetectionTuningSnapshot = (
  tuningPath: string,
): Effect.Effect<WakewordDetectionTuningSnapshot, WakewordSnapshotError> =>
  Effect.tryPromise({
    try: async () => {
      const contents = await readFile(tuningPath, "utf8")
      const parsed: unknown = JSON.parse(contents)
      if (!isWakewordDetectionTuningSnapshot(parsed)) {
        throw new WakewordSnapshotError({
          message: `Invalid detection tuning snapshot format at ${tuningPath}`,
        })
      }
      return parsed
    },
    catch: (cause) =>
      cause instanceof WakewordSnapshotError
        ? cause
        : isEnoent(cause)
          ? new WakewordSnapshotError({
              message: `Tuning snapshot not found at ${tuningPath}. Run 'pie wakeword-tune --name <model>' first.`,
              cause,
            })
          : new WakewordSnapshotError({
              message: `Failed to read detection tuning snapshot at ${tuningPath}`,
              cause,
            }),
  })

const isEnoent = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export class WakewordSnapshotError extends Data.TaggedError("WakewordSnapshotError")<{
  readonly message: string
  readonly cause?: unknown
}> {}
