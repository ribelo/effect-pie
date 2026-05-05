import { Console, Effect } from "effect"
import * as Data from "effect/Data"
import * as path from "node:path"
import { mkdir as mkdirNode, readFile, writeFile as writeNodeFile } from "node:fs/promises"
import { EFFECT_PI_WAKEWORD_CONFIG_DIR } from "../paths.js"
import { isRecord } from "../utils/runtime.js"
import { clamp, percentile, type CliError } from "./shared.js"
import { createWakewordTriggerMachine } from "../wakeword/trigger.js"
import {
  makeWakewordPipeline,
  type WakewordPipeline,
  type WakewordPipelineError,
} from "../wakeword/pipeline.js"
import { loadSavedWavClips, WakewordTrainingError } from "../wakeword/training.js"
import {
  loadLinearWakewordModel,
  type WakewordFeatureSessions,
  type WakewordRuntimeError,
} from "../wakeword/onnx.js"
import type { PulseAudioClient } from "../pulse/client.js"
import type { SourceInfo } from "../pulse/defs.js"
import {
  collectAudioMetricsInteractive,
  isMonitorSource,
  sourceProbeScore,
} from "./audioCapture.js"

export const DEFAULT_CALIBRATION_PRE_ROLL_MS = 300
export const DEFAULT_CALIBRATION_MAX_WAIT_SECONDS = 12

export type WakewordCalibrationSnapshot = {
  readonly schemaVersion: 1
  readonly createdAt: string
  readonly sourceName: string
  readonly noiseRmsP95: number
  readonly speechRmsP50: number
  readonly speechRmsP80: number
  readonly resolved: {
    readonly speechRms: number
    readonly speechChunks: number
    readonly preRollMs: number
    readonly maxWaitSeconds: number
  }
}

export const isWakewordCalibrationSnapshot = (
  value: unknown,
): value is WakewordCalibrationSnapshot => {
  if (!isRecord(value)) {
    return false
  }

  const snapshot = value
  const resolved = snapshot["resolved"]

  if (!isRecord(resolved)) {
    return false
  }

  const resolvedRecord = resolved

  return (
    snapshot["schemaVersion"] === 1 &&
    typeof snapshot["createdAt"] === "string" &&
    typeof snapshot["sourceName"] === "string" &&
    typeof snapshot["noiseRmsP95"] === "number" &&
    typeof snapshot["speechRmsP50"] === "number" &&
    typeof snapshot["speechRmsP80"] === "number" &&
    typeof resolvedRecord["speechRms"] === "number" &&
    typeof resolvedRecord["speechChunks"] === "number" &&
    typeof resolvedRecord["preRollMs"] === "number" &&
    typeof resolvedRecord["maxWaitSeconds"] === "number"
  )
}

export class WakewordSnapshotError extends Data.TaggedError("WakewordSnapshotError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

const isEnoent = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"

export const readCalibrationSnapshot = (
  calibrationPath: string,
): Effect.Effect<WakewordCalibrationSnapshot | undefined> =>
  Effect.tryPromise({
    try: async () => {
      const contents = await readFile(calibrationPath, "utf8")
      const parsed: unknown = JSON.parse(contents)
      return isWakewordCalibrationSnapshot(parsed) ? parsed : undefined
    },
    catch: (cause) =>
      new WakewordSnapshotError({
        message: `Failed to read calibration snapshot at ${calibrationPath}`,
        cause,
      }),
  }).pipe(
    Effect.catchIf(isEnoent, () => Effect.succeed(undefined)),
    Effect.tapError((error) =>
      Effect.logWarning(error.message).pipe(Effect.annotateLogs({ cause: error.cause })),
    ),
    Effect.matchEffect({
      onFailure: () => Effect.succeed(undefined),
      onSuccess: (value) => Effect.succeed(value),
    }),
  )

export const writeCalibrationSnapshot = Effect.fn(
  "pie/commands/wakewordHelpers.writeCalibrationSnapshot",
)(function* (
  calibrationPath: string,
  snapshot: WakewordCalibrationSnapshot,
): Effect.fn.Return<void, WakewordTrainingError> {
  return yield* Effect.tryPromise({
    try: async () => {
      await mkdirNode(path.dirname(calibrationPath), { recursive: true })
      await writeNodeFile(calibrationPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8")
    },
    catch: (cause) =>
      new WakewordTrainingError({
        message: `Failed to write calibration snapshot at ${calibrationPath}`,
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

export const writeDetectionTuningSnapshot = Effect.fn(
  "pie/commands/wakewordHelpers.writeDetectionTuningSnapshot",
)(function* (
  tuningPath: string,
  snapshot: WakewordDetectionTuningSnapshot,
): Effect.fn.Return<void, WakewordTrainingError> {
  return yield* Effect.tryPromise({
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

export const detectionTuningPathFor = (modelName: string): string =>
  path.join(EFFECT_PI_WAKEWORD_CONFIG_DIR, modelName, "detection-tuning.json")

export const calibrationPathFor = (modelName: string): string =>
  path.join(EFFECT_PI_WAKEWORD_CONFIG_DIR, modelName, "calibration.json")

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

export const scorePcmClips = Effect.fn("pie/commands/wakewordHelpers.scorePcmClips")(
  function* (config: {
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
  },
)

export const evaluateTriggerTuning = Effect.fn(
  "pie/commands/wakewordHelpers.evaluateTriggerTuning",
)(function* (config: {
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
})

export const runPostTrainValidationAndTuning = Effect.fn(
  "pie/commands/wakewordHelpers.runPostTrainValidationAndTuning",
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

export type AutoCalibrationResult = {
  readonly sourceName: string
  readonly noiseRmsP95: number
  readonly speechRmsP50: number
  readonly speechRmsP80: number
  readonly resolvedSpeechRms: number
  readonly resolvedSpeechChunks: number
  readonly resolvedPreRollMs: number
  readonly resolvedMaxWaitSeconds: number
}

export const resolveTrainingSource = Effect.fn(
  "pie/commands/wakewordHelpers.resolveTrainingSource",
)(function* (config: {
  readonly requestedSourceName: string | undefined
  readonly defaultSourceName: string | null
  readonly availableSources: ReadonlyArray<SourceInfo>
  readonly fragmentSize: number
  readonly autoCalibrate: boolean
}): Effect.fn.Return<string, WakewordTrainingError | CliError | Error, PulseAudioClient> {
  if (config.requestedSourceName !== undefined) {
    const exists = config.availableSources.some(
      (source) => source.name === config.requestedSourceName,
    )

    if (!exists) {
      return yield* new WakewordTrainingError({
        message: `Configured source '${config.requestedSourceName}' not found. Run 'pie sources' and select one of the listed source names.`,
      })
    }

    return config.requestedSourceName
  }

  const defaultSource =
    config.availableSources.find((source) => source.name === config.defaultSourceName) ??
    config.availableSources[0]

  if (defaultSource === undefined || defaultSource.name === null) {
    return yield* new WakewordTrainingError({
      message: "No capture source is available in PulseAudio",
    })
  }

  if (!config.autoCalibrate) {
    return defaultSource.name
  }

  const defaultLooksLikeMonitor = isMonitorSource(defaultSource)

  if (!defaultLooksLikeMonitor) {
    const defaultProbe = yield* collectAudioMetricsInteractive({
      fragmentSize: config.fragmentSize,
      sampleRate: 16_000,
      channels: 1,
      sourceName: defaultSource.name,
      startPrompt: [
        `Auto source check on '${defaultSource.name}'`,
        "Press Enter to start capture, then say the wake phrase once.",
      ].join("\n"),
      stopPrompt: "Press Enter to stop source check and continue.",
    })

    if (defaultProbe.maxRms >= 0.004) {
      yield* Console.log(
        `Auto source selected default '${defaultSource.name}' (max RMS ${defaultProbe.maxRms.toFixed(4)})`,
      )
      return defaultSource.name
    }

    yield* Console.log(
      `Default source '${defaultSource.name}' looks weak (max RMS ${defaultProbe.maxRms.toFixed(4)}). Probing alternatives...`,
    )
  } else {
    yield* Console.log(
      `Default source '${defaultSource.name}' is a monitor source. Probing microphone sources...`,
    )
  }

  const candidates = config.availableSources.filter(
    (source) => source.name !== null && !isMonitorSource(source),
  )

  if (candidates.length === 0) {
    yield* Console.log(
      "No non-monitor capture sources found; falling back to default source from PulseAudio",
    )
    return defaultSource.name
  }

  yield* Console.log("Sequential source probe: each source waits for start/stop confirmation")

  let bestSource = defaultSource.name
  let bestScore = Number.NEGATIVE_INFINITY

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index]

    if (candidate === undefined) {
      continue
    }

    const candidateName = candidate.name

    if (candidateName === null) {
      continue
    }

    const metrics = yield* collectAudioMetricsInteractive({
      fragmentSize: config.fragmentSize,
      sampleRate: 16_000,
      channels: 1,
      sourceName: candidateName,
      startPrompt: [
        `[source probe ${index + 1}/${candidates.length}] ${candidateName}`,
        "Press Enter to start probe, then say wake phrase once.",
      ].join("\n"),
      stopPrompt: "Press Enter to stop this probe and continue.",
    })

    const score = sourceProbeScore(metrics)
    yield* Console.log(
      `[source probe ${index + 1}/${candidates.length}] max_rms=${metrics.maxRms.toFixed(4)} p95=${metrics.rmsP95.toFixed(4)} score=${score.toFixed(4)}`,
    )

    if (score > bestScore) {
      bestScore = score
      bestSource = candidateName
    }
  }

  yield* Console.log(`Auto source selected: ${bestSource}`)
  return bestSource
})

export const runAutoCalibration = Effect.fn("pie/commands/wakewordHelpers.runAutoCalibration")(
  function* (config: {
    readonly sourceName: string
    readonly fragmentSize: number
    readonly wakePhrase: string
  }): Effect.fn.Return<AutoCalibrationResult, Error | WakewordTrainingError, PulseAudioClient> {
    const noise = yield* collectAudioMetricsInteractive({
      fragmentSize: config.fragmentSize,
      sampleRate: 16_000,
      channels: 1,
      sourceName: config.sourceName,
      startPrompt: [
        "Calibration step 1/2: noise floor",
        "Stay quiet.",
        "Press Enter to start noise capture.",
      ].join("\n"),
      stopPrompt: "Press Enter to stop noise capture.",
    })

    yield* Console.log(
      `Calibration noise floor: p95=${noise.rmsP95.toFixed(4)} max=${noise.maxRms.toFixed(4)}`,
    )

    const speech = yield* collectAudioMetricsInteractive({
      fragmentSize: config.fragmentSize,
      sampleRate: 16_000,
      channels: 1,
      sourceName: config.sourceName,
      startPrompt: [
        "Calibration step 2/2: speech level",
        `Say '${config.wakePhrase}' a few times.`,
        "Press Enter to start speech capture.",
      ].join("\n"),
      stopPrompt: "Press Enter to stop speech capture and continue.",
    })

    const noiseGate = Math.max(0.0005, noise.rmsP95 * 1.2)
    const activeSpeech = speech.rmsValues.filter((value) => value >= noiseGate)
    const speechPopulation = activeSpeech.length > 0 ? activeSpeech : speech.rmsValues

    const speechRmsP50 = percentile(speechPopulation, 0.5)
    const speechRmsP80 = percentile(speechPopulation, 0.8)

    const resolvedSpeechRms = clamp(Math.max(noise.rmsP95 * 2.5, speechRmsP50 * 0.45), 0.001, 0.03)

    const chunkDurationMs = (config.fragmentSize / (16_000 * 1 * 2)) * 1000
    const resolvedSpeechChunks = Math.max(1, Math.min(6, Math.round(90 / chunkDurationMs)))

    return {
      sourceName: config.sourceName,
      noiseRmsP95: noise.rmsP95,
      speechRmsP50,
      speechRmsP80,
      resolvedSpeechRms,
      resolvedSpeechChunks,
      resolvedPreRollMs: DEFAULT_CALIBRATION_PRE_ROLL_MS,
      resolvedMaxWaitSeconds: DEFAULT_CALIBRATION_MAX_WAIT_SECONDS,
    }
  },
)
