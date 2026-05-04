import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import { promises as fs } from "node:fs"
import * as path from "node:path"

import { EFFECT_PI_OPENWAKEWORD_DATA_DIR } from "../paths.js"
import { buildPcmWavHeader, isRecord } from "../utils/runtime.js"
import {
  OPENWAKEWORD_MEL_BINS,
  OPENWAKEWORD_MEL_WINDOW_FRAMES,
  OPENWAKEWORD_SAMPLE_RATE,
} from "./defs.js"
import type { WakewordFeatureSessions, WakewordRuntimeError } from "./onnx.js"
import { flattenMatrix, toFrameMatrix, transformMelspectrogram } from "./signal.js"

export class WakewordTrainingError extends Data.TaggedError("WakewordTrainingError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

export type WakewordTrainingPlan = {
  readonly modelName: string
  readonly outputModelFileName: string
  readonly assetRootDir: string
  readonly datasetRootDir: string
  readonly workspaceDir: string
  readonly positiveDir: string
  readonly negativeDir: string
  readonly silenceDir: string
  readonly testDir: string
  readonly outputDir: string
  readonly outputModelPath: string
  readonly manifestPath: string
}

export type WakewordTrainingPlanOptions = {
  readonly name: string
  readonly assetRootDir?: string
  readonly datasetRootDir?: string
  readonly outputDir?: string
  readonly manifestPath?: string
}

export type TrainedLinearWakewordModel = {
  readonly schemaVersion: 1
  readonly type: "linear_wakeword"
  readonly frameCount: number
  readonly featureSize: number
  readonly weights: ReadonlyArray<number>
  readonly bias: number
  readonly logitScale: number
  readonly metrics: {
    readonly positiveMean: number
    readonly negativeMean: number
    readonly positiveStdDev: number
    readonly negativeStdDev: number
  }
}

const sanitizeModelName = (name: string): string =>
  name
    .trim()
    .toLowerCase()
    .replace(/\.onnx$/i, "")
    .replace(/\.json$/i, "")
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")

const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x))

const averageVectors = (vectors: ReadonlyArray<Float32Array>): Float32Array => {
  if (vectors.length === 0) {
    return new Float32Array()
  }

  const size = vectors[0]?.length ?? 0
  const out = new Float32Array(size)

  for (const vector of vectors) {
    for (let index = 0; index < size; index += 1) {
      out[index] = (out[index] ?? 0) + (vector[index] ?? 0)
    }
  }

  for (let index = 0; index < size; index += 1) {
    out[index] = (out[index] ?? 0) / vectors.length
  }

  return out
}

const dot = (left: Float32Array, right: Float32Array): number => {
  const size = Math.min(left.length, right.length)
  let sum = 0
  for (let index = 0; index < size; index += 1) {
    sum += (left[index] ?? 0) * (right[index] ?? 0)
  }
  return sum
}

const mean = (values: ReadonlyArray<number>): number => {
  if (values.length === 0) {
    return 0
  }
  return values.reduce((acc, value) => acc + value, 0) / values.length
}

const stdDev = (values: ReadonlyArray<number>): number => {
  if (values.length <= 1) {
    return 0
  }

  const mu = mean(values)
  const variance = values.reduce((acc, value) => acc + (value - mu) ** 2, 0) / values.length
  return Math.sqrt(variance)
}

const resolveLogitScale = (
  positiveRawScores: ReadonlyArray<number>,
  negativeRawScores: ReadonlyArray<number>,
  bias: number,
): number => {
  const positiveMeanRaw = mean(positiveRawScores)
  const negativeMeanRaw = mean(negativeRawScores)
  const spreadScale = Math.abs(positiveMeanRaw - negativeMeanRaw) / 32
  const biasScale = Math.abs(bias) / 8

  const scale = Math.max(1, Math.min(512, spreadScale), Math.min(512, biasScale))
  return Number.isFinite(scale) ? scale : 1
}

export const makeWakewordTrainingPlan = (
  options: WakewordTrainingPlanOptions,
): WakewordTrainingPlan => {
  const modelName = sanitizeModelName(options.name)

  if (modelName.length === 0) {
    throw new WakewordTrainingError({
      message: "Invalid wakeword model name. Use letters, numbers, hyphen, or underscore.",
    })
  }

  const assetRootDir = path.resolve(options.assetRootDir ?? EFFECT_PI_OPENWAKEWORD_DATA_DIR)

  const datasetRootDir = path.resolve(options.datasetRootDir ?? path.join(assetRootDir, "training"))
  const outputDir = path.resolve(options.outputDir ?? path.join(assetRootDir, "wakewords"))
  const manifestPath = path.resolve(
    options.manifestPath ?? path.join(assetRootDir, "manifest.json"),
  )

  const workspaceDir = path.join(datasetRootDir, modelName)
  const outputModelFileName = `${modelName}.json`

  return {
    modelName,
    outputModelFileName,
    assetRootDir,
    datasetRootDir,
    workspaceDir,
    positiveDir: path.join(workspaceDir, "positive"),
    negativeDir: path.join(workspaceDir, "negative"),
    silenceDir: path.join(workspaceDir, "silence"),
    testDir: path.join(workspaceDir, "test"),
    outputDir,
    outputModelPath: path.join(outputDir, outputModelFileName),
    manifestPath,
  }
}

const buildTrainingReadme = (
  plan: WakewordTrainingPlan,
): string => `# Wakeword Training Workspace: ${plan.modelName}

This workspace was generated by:

- \`pie wakeword-train --name ${plan.modelName}\`

## Directory Layout

- \`positive/\` -- clips containing your target phrase
- \`negative/\` -- clips with non-target speech/noise
- \`silence/\` -- clips with no speech (background noise only)
- \`test/\` -- optional holdout clips

## Audio Guidelines

- 16 kHz
- mono
- PCM WAV
- close-talk + far-field samples

## Output Target

The trained model will be written to:

- \`${plan.outputModelPath}\`

## Training Modes

- Full (default): \`pie wakeword-train --name ${plan.modelName} --register\`
- Append negatives only: \`pie wakeword-train --name ${plan.modelName} --capture-negatives-only\`
- Train from saved clips: \`pie wakeword-train --name ${plan.modelName} --train-only\`

The positive prompts are speech-activated: recording waits until speech is detected and retries automatically when silence is captured.

## Verify

- \`pie wakeword --models ${plan.outputModelFileName} --duration 20\`
`

export const initializeWakewordTrainingWorkspace = (
  plan: WakewordTrainingPlan,
): Effect.Effect<void, WakewordTrainingError> =>
  Effect.tryPromise({
    try: async () => {
      await fs.mkdir(plan.positiveDir, { recursive: true })
      await fs.mkdir(plan.negativeDir, { recursive: true })
      await fs.mkdir(plan.silenceDir, { recursive: true })
      await fs.mkdir(plan.testDir, { recursive: true })
      await fs.mkdir(plan.outputDir, { recursive: true })

      const readmePath = path.join(plan.workspaceDir, "README.md")
      const exists = await fs
        .access(readmePath)
        .then(() => true)
        .catch(() => false)

      if (!exists) {
        await fs.writeFile(readmePath, buildTrainingReadme(plan), "utf8")
      }

      const gitkeepTargets = [plan.positiveDir, plan.negativeDir, plan.silenceDir, plan.testDir]
      for (const dir of gitkeepTargets) {
        const keepPath = path.join(dir, ".gitkeep")
        const keepExists = await fs
          .access(keepPath)
          .then(() => true)
          .catch(() => false)
        if (!keepExists) {
          await fs.writeFile(keepPath, "", "utf8")
        }
      }
    },
    catch: (cause) =>
      new WakewordTrainingError({
        message: "Failed to initialize wakeword training workspace",
        cause,
      }),
  })

type WakewordManifest = {
  readonly schemaVersion: number
  readonly runtime: {
    readonly package: string
    readonly version: string
  }
  readonly models: {
    readonly melspectrogram: string
    readonly embedding: string
    readonly wakewords: Array<string>
  }
}

const isWakewordManifest = (value: unknown): value is WakewordManifest =>
  isRecord(value) &&
  isRecord(value["runtime"]) &&
  isRecord(value["models"]) &&
  typeof value["schemaVersion"] === "number" &&
  typeof value["runtime"]["package"] === "string" &&
  typeof value["runtime"]["version"] === "string" &&
  typeof value["models"]["melspectrogram"] === "string" &&
  typeof value["models"]["embedding"] === "string" &&
  Array.isArray(value["models"]["wakewords"]) &&
  value["models"]["wakewords"].every((entry) => typeof entry === "string")

export const registerWakewordModelInManifest = (
  manifestPath: string,
  modelFileName: string,
): Effect.Effect<boolean, WakewordTrainingError> =>
  Effect.tryPromise({
    try: async () => {
      const raw = await fs.readFile(manifestPath, "utf8")
      const manifest: unknown = JSON.parse(raw)

      if (!isWakewordManifest(manifest)) {
        throw new WakewordTrainingError({
          message: "manifest must match the wakeword asset schema",
        })
      }

      const wakewords = manifest.models.wakewords

      const alreadyPresent = wakewords.includes(modelFileName)
      if (alreadyPresent) {
        return false
      }

      wakewords.push(modelFileName)
      await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8")
      return true
    },
    catch: (cause) =>
      new WakewordTrainingError({
        message: `Failed to update wakeword manifest at ${manifestPath} with ${modelFileName}`,
        cause,
      }),
  })

export const writePcmWavFile = (
  outputPath: string,
  pcmBytes: Uint8Array,
  sampleRate = OPENWAKEWORD_SAMPLE_RATE,
): Effect.Effect<void, WakewordTrainingError> =>
  Effect.tryPromise({
    try: async () => {
      const header = buildPcmWavHeader(pcmBytes.length, sampleRate)

      const wavData = new Uint8Array(44 + pcmBytes.length)
      wavData.set(header, 0)
      wavData.set(pcmBytes, 44)

      await fs.mkdir(path.dirname(outputPath), { recursive: true })
      await fs.writeFile(outputPath, wavData)
    },
    catch: (cause) =>
      new WakewordTrainingError({
        message: `Failed to write WAV file ${outputPath}`,
        cause,
      }),
  })

const toInt16Samples = (pcmBytes: Uint8Array): Int16Array => {
  const sampleCount = Math.floor(pcmBytes.length / 2)
  const view = new DataView(pcmBytes.buffer, pcmBytes.byteOffset, sampleCount * 2)
  const samples = new Int16Array(sampleCount)

  for (let index = 0; index < sampleCount; index += 1) {
    samples[index] = view.getInt16(index * 2, true)
  }

  return samples
}

const clipEmbeddingFromPcm = (
  sessions: WakewordFeatureSessions,
  pcmBytes: Uint8Array,
): Effect.Effect<Float32Array, WakewordTrainingError> =>
  Effect.gen(function* () {
    const samples = toInt16Samples(pcmBytes)
    const melInput = Float32Array.from(samples)

    const mel = yield* sessions.melspectrogram
      .run({
        data: melInput,
        dims: [1, melInput.length],
      })
      .pipe(
        Effect.map((output) => transformMelspectrogram(output.data)),
        Effect.mapError(
          (cause: WakewordRuntimeError) =>
            new WakewordTrainingError({
              message: "Failed to run melspectrogram model during training",
              cause,
            }),
        ),
      )

    const melFrames = toFrameMatrix(mel, OPENWAKEWORD_MEL_BINS)
    if (melFrames.length === 0) {
      return yield* new WakewordTrainingError({
        message: "Training clip is too short to produce melspectrogram frames",
      })
    }

    const embeddings: Array<Float32Array> = []
    for (let start = 0; start + OPENWAKEWORD_MEL_WINDOW_FRAMES <= melFrames.length; start += 8) {
      const window = melFrames.slice(start, start + OPENWAKEWORD_MEL_WINDOW_FRAMES)
      const input = flattenMatrix(window)

      const embedding = yield* sessions.embedding
        .run({
          data: input,
          dims: [1, OPENWAKEWORD_MEL_WINDOW_FRAMES, OPENWAKEWORD_MEL_BINS, 1],
        })
        .pipe(
          Effect.map((output) => output.data),
          Effect.mapError(
            (cause: WakewordRuntimeError) =>
              new WakewordTrainingError({
                message: "Failed to run embedding model during training",
                cause,
              }),
          ),
        )

      embeddings.push(embedding)
    }

    if (embeddings.length === 0) {
      const padded = [
        ...Array.from(
          { length: Math.max(0, OPENWAKEWORD_MEL_WINDOW_FRAMES - melFrames.length) },
          () => Float32Array.from({ length: OPENWAKEWORD_MEL_BINS }, () => 1),
        ),
        ...melFrames,
      ].slice(-OPENWAKEWORD_MEL_WINDOW_FRAMES)

      const input = flattenMatrix(padded)
      const embedding = yield* sessions.embedding
        .run({
          data: input,
          dims: [1, OPENWAKEWORD_MEL_WINDOW_FRAMES, OPENWAKEWORD_MEL_BINS, 1],
        })
        .pipe(
          Effect.map((output) => output.data),
          Effect.mapError(
            (cause: WakewordRuntimeError) =>
              new WakewordTrainingError({
                message: "Failed to run embedding model during training",
                cause,
              }),
          ),
        )

      embeddings.push(embedding)
    }

    return averageVectors(embeddings)
  })

export const trainLinearWakewordModel = (
  sessions: WakewordFeatureSessions,
  options: {
    readonly positiveClips: ReadonlyArray<Uint8Array>
    readonly negativeClips: ReadonlyArray<Uint8Array>
    readonly frameCount?: number
  },
): Effect.Effect<TrainedLinearWakewordModel, WakewordTrainingError> =>
  Effect.gen(function* () {
    if (options.positiveClips.length < 3) {
      return yield* new WakewordTrainingError({
        message: "Need at least 3 positive clips to train wakeword model",
      })
    }

    if (options.negativeClips.length < 3) {
      return yield* new WakewordTrainingError({
        message: "Need at least 3 negative clips to train wakeword model",
      })
    }

    const positiveEmbeddings: Array<Float32Array> = []
    const negativeEmbeddings: Array<Float32Array> = []

    for (const clip of options.positiveClips) {
      positiveEmbeddings.push(yield* clipEmbeddingFromPcm(sessions, clip))
    }

    for (const clip of options.negativeClips) {
      negativeEmbeddings.push(yield* clipEmbeddingFromPcm(sessions, clip))
    }

    const positiveCenter = averageVectors(positiveEmbeddings)
    const negativeCenter = averageVectors(negativeEmbeddings)

    if (positiveCenter.length === 0 || negativeCenter.length === 0) {
      return yield* new WakewordTrainingError({
        message: "Failed to compute training embeddings",
      })
    }

    const weights = new Float32Array(positiveCenter.length)
    for (let index = 0; index < weights.length; index += 1) {
      weights[index] = (positiveCenter[index] ?? 0) - (negativeCenter[index] ?? 0)
    }

    const bias = -0.5 * (dot(weights, positiveCenter) + dot(weights, negativeCenter))

    const positiveRawScores = positiveEmbeddings.map((embedding) => dot(weights, embedding) + bias)
    const negativeRawScores = negativeEmbeddings.map((embedding) => dot(weights, embedding) + bias)

    const logitScale = resolveLogitScale(positiveRawScores, negativeRawScores, bias)

    const positiveScores = positiveRawScores.map((raw) => sigmoid(raw / logitScale))
    const negativeScores = negativeRawScores.map((raw) => sigmoid(raw / logitScale))

    return {
      schemaVersion: 1,
      type: "linear_wakeword",
      frameCount: options.frameCount ?? 16,
      featureSize: weights.length,
      weights: Array.from(weights),
      bias,
      logitScale,
      metrics: {
        positiveMean: mean(positiveScores),
        negativeMean: mean(negativeScores),
        positiveStdDev: stdDev(positiveScores),
        negativeStdDev: stdDev(negativeScores),
      },
    }
  })

export const sortedWavPaths = async (dir: string): Promise<ReadonlyArray<string>> => {
  const entries = await fs.readdir(dir)
  return entries
    .filter((entry) => entry.toLowerCase().endsWith(".wav"))
    .sort((left, right) => left.localeCompare(right))
    .map((entry) => path.join(dir, entry))
}

export const nextWavPath = (
  dir: string,
  label: string,
): Effect.Effect<string, WakewordTrainingError> =>
  Effect.tryPromise({
    try: async () => {
      const entries = await fs.readdir(dir)
      const pattern = new RegExp(`^${label}-(\\d{3})\\.wav$`, "i")
      let maxNumber = 0

      for (const entry of entries) {
        const match = pattern.exec(entry)
        if (match !== null) {
          const number = parseInt(match[1] ?? "0", 10)
          if (number > maxNumber) {
            maxNumber = number
          }
        }
      }

      return path.join(dir, `${label}-${String(maxNumber + 1).padStart(3, "0")}.wav`)
    },
    catch: (cause) =>
      new WakewordTrainingError({
        message: `Failed to determine next WAV path in ${dir} for label ${label}`,
        cause,
      }),
  })

export const decodePcmWavFile = (
  wavPath: string,
): Effect.Effect<Uint8Array, WakewordTrainingError> =>
  Effect.tryPromise({
    try: async () => {
      const data = await fs.readFile(wavPath)
      if (data.length < 44) {
        throw new WakewordTrainingError({
          message: `WAV file too short: ${wavPath}`,
        })
      }

      const view = new DataView(data.buffer, data.byteOffset, data.byteLength)

      const riffMagic = String.fromCharCode(data[0] ?? 0, data[1] ?? 0, data[2] ?? 0, data[3] ?? 0)
      if (riffMagic !== "RIFF") {
        throw new WakewordTrainingError({
          message: `Not a RIFF file: ${wavPath}`,
        })
      }

      const waveMagic = String.fromCharCode(
        data[8] ?? 0,
        data[9] ?? 0,
        data[10] ?? 0,
        data[11] ?? 0,
      )
      if (waveMagic !== "WAVE") {
        throw new WakewordTrainingError({
          message: `Not a WAVE file: ${wavPath}`,
        })
      }

      const fmtMagic = String.fromCharCode(
        data[12] ?? 0,
        data[13] ?? 0,
        data[14] ?? 0,
        data[15] ?? 0,
      )
      if (fmtMagic !== "fmt ") {
        throw new WakewordTrainingError({
          message: `Missing fmt chunk: ${wavPath}`,
        })
      }

      const audioFormat = view.getUint16(20, true)
      if (audioFormat !== 1) {
        throw new WakewordTrainingError({
          message: `Expected PCM format (1), got ${audioFormat}: ${wavPath}`,
        })
      }

      const channels = view.getUint16(22, true)
      if (channels !== 1) {
        throw new WakewordTrainingError({
          message: `Expected mono (1 channel), got ${channels}: ${wavPath}`,
        })
      }

      const sampleRate = view.getUint32(24, true)
      if (sampleRate !== OPENWAKEWORD_SAMPLE_RATE) {
        throw new WakewordTrainingError({
          message: `Expected ${OPENWAKEWORD_SAMPLE_RATE} Hz, got ${sampleRate}: ${wavPath}`,
        })
      }

      const bitsPerSample = view.getUint16(34, true)
      if (bitsPerSample !== 16) {
        throw new WakewordTrainingError({
          message: `Expected 16-bit samples, got ${bitsPerSample}: ${wavPath}`,
        })
      }

      const dataMagic = String.fromCharCode(
        data[36] ?? 0,
        data[37] ?? 0,
        data[38] ?? 0,
        data[39] ?? 0,
      )
      if (dataMagic !== "data") {
        throw new WakewordTrainingError({
          message: `Missing data chunk: ${wavPath}`,
        })
      }

      const dataSize = view.getUint32(40, true)
      const pcmOffset = 44
      const expectedLength = pcmOffset + dataSize

      if (data.length < expectedLength) {
        throw new WakewordTrainingError({
          message: `Truncated WAV data: expected ${expectedLength} bytes, got ${data.length}: ${wavPath}`,
        })
      }

      return new Uint8Array(data.buffer, data.byteOffset + pcmOffset, dataSize)
    },
    catch: (cause) => {
      if (cause instanceof WakewordTrainingError) {
        return cause
      }
      return new WakewordTrainingError({
        message: `Failed to decode WAV file: ${wavPath}`,
        cause,
      })
    },
  })

export const loadSavedWavClips = (
  dir: string,
): Effect.Effect<ReadonlyArray<Uint8Array>, WakewordTrainingError> =>
  Effect.gen(function* () {
    const wavPaths = yield* Effect.tryPromise({
      try: () => sortedWavPaths(dir),
      catch: (cause) =>
        new WakewordTrainingError({
          message: `Failed to list WAV files in ${dir}`,
          cause,
        }),
    })

    const clips: Array<Uint8Array> = []
    for (const wavPath of wavPaths) {
      const pcm = yield* decodePcmWavFile(wavPath)
      clips.push(pcm)
    }

    return clips
  })

export const validateMinimumClips = (config: {
  readonly dir: string
  readonly label: string
  readonly minimum: number
}): Effect.Effect<void, WakewordTrainingError> =>
  Effect.gen(function* () {
    const wavPaths = yield* Effect.tryPromise({
      try: () => sortedWavPaths(config.dir),
      catch: (cause) =>
        new WakewordTrainingError({
          message: `Failed to list WAV files in ${config.dir}`,
          cause,
        }),
    })

    if (wavPaths.length < config.minimum) {
      return yield* new WakewordTrainingError({
        message: `${config.label} dataset needs at least ${config.minimum} clips, found ${wavPaths.length} in ${config.dir}`,
      })
    }
  })

export const saveTrainedWakewordModel = (
  outputPath: string,
  model: TrainedLinearWakewordModel,
): Effect.Effect<void, WakewordTrainingError> =>
  Effect.tryPromise({
    try: async () => {
      await fs.mkdir(path.dirname(outputPath), { recursive: true })
      await fs.writeFile(outputPath, `${JSON.stringify(model, null, 2)}\n`, "utf8")
    },
    catch: (cause) =>
      new WakewordTrainingError({
        message: `Failed to save trained wakeword model to ${outputPath}`,
        cause,
      }),
  })
