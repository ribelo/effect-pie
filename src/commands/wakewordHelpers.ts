import { Console, Effect } from "effect"
import * as Data from "effect/Data"
import * as path from "node:path"
import { mkdir as mkdirNode, readFile, writeFile as writeNodeFile } from "node:fs/promises"
import { EFFECT_PI_WAKEWORD_CONFIG_DIR } from "../paths.js"
import { isRecord } from "../utils/isRecord.js"
import { clamp, percentile } from "./shared.js"
import type { WakewordTrainingError } from "../wakeword/training.js"
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
): Effect.fn.Return<void, WakewordSnapshotError> {
  yield* Effect.tryPromise({
    try: async () => {
      await mkdirNode(path.dirname(calibrationPath), { recursive: true })
      await writeNodeFile(calibrationPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8")
    },
    catch: (cause) =>
      new WakewordSnapshotError({
        message: `Failed to write calibration snapshot at ${calibrationPath}`,
        cause,
      }),
  })
})

export const detectionTuningPathFor = (modelName: string): string =>
  path.join(EFFECT_PI_WAKEWORD_CONFIG_DIR, modelName, "detection-tuning.json")

export const calibrationPathFor = (modelName: string): string =>
  path.join(EFFECT_PI_WAKEWORD_CONFIG_DIR, modelName, "calibration.json")

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
}): Effect.fn.Return<
  string,
  WakewordSnapshotError | WakewordTrainingError | Error,
  PulseAudioClient
> {
  if (config.requestedSourceName !== undefined) {
    const exists = config.availableSources.some(
      (source) => source.name === config.requestedSourceName,
    )

    if (!exists) {
      return yield* new WakewordSnapshotError({
        message: `Configured source '${config.requestedSourceName}' not found. Run 'pie sources' and select one of the listed source names.`,
      })
    }

    return config.requestedSourceName
  }

  const defaultSource =
    config.availableSources.find((source) => source.name === config.defaultSourceName) ??
    config.availableSources[0]

  if (defaultSource === undefined || defaultSource.name === null) {
    return yield* new WakewordSnapshotError({
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
  }): Effect.fn.Return<
    AutoCalibrationResult,
    Error | WakewordTrainingError | WakewordSnapshotError,
    PulseAudioClient
  > {
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
