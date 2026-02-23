import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { promises as fs } from "node:fs";
import * as path from "node:path";

import { EFFECT_PI_OPENWAKEWORD_DATA_DIR } from "../paths.js";
import {
  OPENWAKEWORD_MEL_BINS,
  OPENWAKEWORD_MEL_WINDOW_FRAMES,
  OPENWAKEWORD_SAMPLE_RATE,
} from "./defs.js";
import { type WakewordFeatureSessions, type WakewordRuntimeError } from "./onnx.js";

export class WakewordTrainingError extends Data.TaggedError("WakewordTrainingError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export type WakewordTrainingPlan = {
  readonly modelName: string;
  readonly outputModelFileName: string;
  readonly assetRootDir: string;
  readonly datasetRootDir: string;
  readonly workspaceDir: string;
  readonly positiveDir: string;
  readonly negativeDir: string;
  readonly testDir: string;
  readonly outputDir: string;
  readonly outputModelPath: string;
  readonly manifestPath: string;
};

export type WakewordTrainingPlanOptions = {
  readonly name: string;
  readonly assetRootDir?: string;
  readonly datasetRootDir?: string;
  readonly outputDir?: string;
  readonly manifestPath?: string;
};

export type TrainedLinearWakewordModel = {
  readonly schemaVersion: 1;
  readonly type: "linear_wakeword";
  readonly frameCount: number;
  readonly featureSize: number;
  readonly weights: ReadonlyArray<number>;
  readonly bias: number;
  readonly logitScale: number;
  readonly metrics: {
    readonly positiveMean: number;
    readonly negativeMean: number;
    readonly positiveStdDev: number;
    readonly negativeStdDev: number;
  };
};

const sanitizeModelName = (name: string): string =>
  name
    .trim()
    .toLowerCase()
    .replace(/\.onnx$/i, "")
    .replace(/\.json$/i, "")
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");

const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));

const toFrameMatrix = (data: Float32Array, featureCount: number): Array<Float32Array> => {
  if (featureCount <= 0) {
    return [];
  }

  const frameCount = Math.floor(data.length / featureCount);
  const frames: Array<Float32Array> = [];

  for (let frame = 0; frame < frameCount; frame += 1) {
    const start = frame * featureCount;
    frames.push(data.slice(start, start + featureCount));
  }

  return frames;
};

const flattenMatrix = (rows: ReadonlyArray<Float32Array>): Float32Array => {
  if (rows.length === 0) {
    return new Float32Array();
  }

  const width = rows[0]?.length ?? 0;
  const out = new Float32Array(rows.length * width);

  let offset = 0;
  for (const row of rows) {
    out.set(row, offset);
    offset += row.length;
  }

  return out;
};

const transformMelspectrogram = (data: Float32Array): Float32Array => {
  const transformed = new Float32Array(data.length);
  for (let index = 0; index < data.length; index += 1) {
    transformed[index] = data[index] / 10 + 2;
  }
  return transformed;
};

const averageVectors = (vectors: ReadonlyArray<Float32Array>): Float32Array => {
  if (vectors.length === 0) {
    return new Float32Array();
  }

  const size = vectors[0]?.length ?? 0;
  const out = new Float32Array(size);

  for (const vector of vectors) {
    for (let index = 0; index < size; index += 1) {
      out[index] += vector[index] ?? 0;
    }
  }

  for (let index = 0; index < size; index += 1) {
    out[index] /= vectors.length;
  }

  return out;
};

const dot = (left: Float32Array, right: Float32Array): number => {
  const size = Math.min(left.length, right.length);
  let sum = 0;
  for (let index = 0; index < size; index += 1) {
    sum += (left[index] ?? 0) * (right[index] ?? 0);
  }
  return sum;
};

const mean = (values: ReadonlyArray<number>): number => {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((acc, value) => acc + value, 0) / values.length;
};

const stdDev = (values: ReadonlyArray<number>): number => {
  if (values.length <= 1) {
    return 0;
  }

  const mu = mean(values);
  const variance = values.reduce((acc, value) => acc + (value - mu) ** 2, 0) / values.length;
  return Math.sqrt(variance);
};

const resolveLogitScale = (
  positiveRawScores: ReadonlyArray<number>,
  negativeRawScores: ReadonlyArray<number>,
  bias: number,
): number => {
  const positiveMeanRaw = mean(positiveRawScores);
  const negativeMeanRaw = mean(negativeRawScores);
  const spreadScale = Math.abs(positiveMeanRaw - negativeMeanRaw) / 32;
  const biasScale = Math.abs(bias) / 8;

  const scale = Math.max(1, Math.min(512, spreadScale), Math.min(512, biasScale));
  return Number.isFinite(scale) ? scale : 1;
};

export const makeWakewordTrainingPlan = (
  options: WakewordTrainingPlanOptions,
): WakewordTrainingPlan => {
  const modelName = sanitizeModelName(options.name);

  if (modelName.length === 0) {
    throw new WakewordTrainingError({
      message: "Invalid wakeword model name. Use letters, numbers, hyphen, or underscore.",
    });
  }

  const assetRootDir = path.resolve(options.assetRootDir ?? EFFECT_PI_OPENWAKEWORD_DATA_DIR);

  const datasetRootDir = path.resolve(
    options.datasetRootDir ?? path.join(assetRootDir, "training"),
  );
  const outputDir = path.resolve(options.outputDir ?? path.join(assetRootDir, "wakewords"));
  const manifestPath = path.resolve(
    options.manifestPath ?? path.join(assetRootDir, "manifest.json"),
  );

  const workspaceDir = path.join(datasetRootDir, modelName);
  const outputModelFileName = `${modelName}.json`;

  return {
    modelName,
    outputModelFileName,
    assetRootDir,
    datasetRootDir,
    workspaceDir,
    positiveDir: path.join(workspaceDir, "positive"),
    negativeDir: path.join(workspaceDir, "negative"),
    testDir: path.join(workspaceDir, "test"),
    outputDir,
    outputModelPath: path.join(outputDir, outputModelFileName),
    manifestPath,
  };
};

const buildTrainingReadme = (
  plan: WakewordTrainingPlan,
): string => `# Wakeword Training Workspace: ${plan.modelName}

This workspace was generated by:

- \`npm run cli -- wakeword-train --name ${plan.modelName}\`

## Directory Layout

- \`positive/\` -- clips containing your target phrase
- \`negative/\` -- clips with non-target speech/noise
- \`test/\` -- optional holdout clips

## Audio Guidelines

- 16 kHz
- mono
- PCM WAV
- close-talk + far-field samples

## Output Target

The trained model will be written to:

- \`${plan.outputModelPath}\`

## One-command Training

Run interactive collection + training:

- \`npm run cli -- wakeword-train --name ${plan.modelName} --register\`

The positive prompts are speech-activated: recording waits until speech is detected and retries automatically when silence is captured.

## Verify

- \`npm run cli -- wakeword --models ${plan.outputModelFileName} --duration 20\`
`;

export const initializeWakewordTrainingWorkspace = (
  plan: WakewordTrainingPlan,
): Effect.Effect<void, WakewordTrainingError> =>
  Effect.tryPromise({
    try: async () => {
      await fs.mkdir(plan.positiveDir, { recursive: true });
      await fs.mkdir(plan.negativeDir, { recursive: true });
      await fs.mkdir(plan.testDir, { recursive: true });
      await fs.mkdir(plan.outputDir, { recursive: true });

      const readmePath = path.join(plan.workspaceDir, "README.md");
      const exists = await fs
        .access(readmePath)
        .then(() => true)
        .catch(() => false);

      if (!exists) {
        await fs.writeFile(readmePath, buildTrainingReadme(plan), "utf8");
      }

      const gitkeepTargets = [plan.positiveDir, plan.negativeDir, plan.testDir];
      for (const dir of gitkeepTargets) {
        const keepPath = path.join(dir, ".gitkeep");
        const keepExists = await fs
          .access(keepPath)
          .then(() => true)
          .catch(() => false);
        if (!keepExists) {
          await fs.writeFile(keepPath, "", "utf8");
        }
      }
    },
    catch: (cause) =>
      new WakewordTrainingError({
        message: "Failed to initialize wakeword training workspace",
        cause,
      }),
  });

type WakewordManifest = {
  readonly schemaVersion: number;
  readonly runtime: {
    readonly package: string;
    readonly version: string;
  };
  readonly models: {
    readonly melspectrogram: string;
    readonly embedding: string;
    readonly wakewords: Array<string>;
  };
};

export const registerWakewordModelInManifest = (
  manifestPath: string,
  modelFileName: string,
): Effect.Effect<boolean, WakewordTrainingError> =>
  Effect.tryPromise({
    try: async () => {
      const raw = await fs.readFile(manifestPath, "utf8");
      const manifest = JSON.parse(raw) as WakewordManifest;

      const wakewords = manifest.models?.wakewords;
      if (!Array.isArray(wakewords)) {
        throw new WakewordTrainingError({
          message: "manifest models.wakewords must be an array",
        });
      }

      const alreadyPresent = wakewords.includes(modelFileName);
      if (alreadyPresent) {
        return false;
      }

      wakewords.push(modelFileName);
      await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      return true;
    },
    catch: (cause) =>
      new WakewordTrainingError({
        message: `Failed to update wakeword manifest at ${manifestPath} with ${modelFileName}`,
        cause,
      }),
  });

export const writePcmWavFile = (
  outputPath: string,
  pcmBytes: Uint8Array,
  sampleRate = OPENWAKEWORD_SAMPLE_RATE,
): Effect.Effect<void, WakewordTrainingError> =>
  Effect.tryPromise({
    try: async () => {
      const header = new ArrayBuffer(44);
      const view = new DataView(header);

      const writeString = (offset: number, value: string): void => {
        for (let index = 0; index < value.length; index += 1) {
          view.setUint8(offset + index, value.charCodeAt(index));
        }
      };

      writeString(0, "RIFF");
      view.setUint32(4, 36 + pcmBytes.length, true);
      writeString(8, "WAVE");
      writeString(12, "fmt ");
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, 1, true);
      view.setUint32(24, sampleRate, true);
      view.setUint32(28, sampleRate * 2, true);
      view.setUint16(32, 2, true);
      view.setUint16(34, 16, true);
      writeString(36, "data");
      view.setUint32(40, pcmBytes.length, true);

      const wavData = new Uint8Array(44 + pcmBytes.length);
      wavData.set(new Uint8Array(header), 0);
      wavData.set(pcmBytes, 44);

      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(outputPath, wavData);
    },
    catch: (cause) =>
      new WakewordTrainingError({
        message: `Failed to write WAV file ${outputPath}`,
        cause,
      }),
  });

const toInt16Samples = (pcmBytes: Uint8Array): Int16Array => {
  const sampleCount = Math.floor(pcmBytes.length / 2);
  const view = new DataView(pcmBytes.buffer, pcmBytes.byteOffset, sampleCount * 2);
  const samples = new Int16Array(sampleCount);

  for (let index = 0; index < sampleCount; index += 1) {
    samples[index] = view.getInt16(index * 2, true);
  }

  return samples;
};

const clipEmbeddingFromPcm = (
  sessions: WakewordFeatureSessions,
  pcmBytes: Uint8Array,
): Effect.Effect<Float32Array, WakewordTrainingError> =>
  Effect.gen(function* () {
    const samples = toInt16Samples(pcmBytes);
    const melInput = Float32Array.from(samples);

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
      );

    const melFrames = toFrameMatrix(mel, OPENWAKEWORD_MEL_BINS);
    if (melFrames.length === 0) {
      return yield* new WakewordTrainingError({
        message: "Training clip is too short to produce melspectrogram frames",
      });
    }

    const embeddings: Array<Float32Array> = [];
    for (let start = 0; start + OPENWAKEWORD_MEL_WINDOW_FRAMES <= melFrames.length; start += 8) {
      const window = melFrames.slice(start, start + OPENWAKEWORD_MEL_WINDOW_FRAMES);
      const input = flattenMatrix(window);

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
        );

      embeddings.push(embedding);
    }

    if (embeddings.length === 0) {
      const padded = [
        ...Array.from(
          { length: Math.max(0, OPENWAKEWORD_MEL_WINDOW_FRAMES - melFrames.length) },
          () => Float32Array.from({ length: OPENWAKEWORD_MEL_BINS }, () => 1),
        ),
        ...melFrames,
      ].slice(-OPENWAKEWORD_MEL_WINDOW_FRAMES);

      const input = flattenMatrix(padded);
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
        );

      embeddings.push(embedding);
    }

    return averageVectors(embeddings);
  });

export const trainLinearWakewordModel = (
  sessions: WakewordFeatureSessions,
  options: {
    readonly positiveClips: ReadonlyArray<Uint8Array>;
    readonly negativeClips: ReadonlyArray<Uint8Array>;
    readonly frameCount?: number;
  },
): Effect.Effect<TrainedLinearWakewordModel, WakewordTrainingError> =>
  Effect.gen(function* () {
    if (options.positiveClips.length < 3) {
      return yield* new WakewordTrainingError({
        message: "Need at least 3 positive clips to train wakeword model",
      });
    }

    if (options.negativeClips.length < 3) {
      return yield* new WakewordTrainingError({
        message: "Need at least 3 negative clips to train wakeword model",
      });
    }

    const positiveEmbeddings: Array<Float32Array> = [];
    const negativeEmbeddings: Array<Float32Array> = [];

    for (const clip of options.positiveClips) {
      positiveEmbeddings.push(yield* clipEmbeddingFromPcm(sessions, clip));
    }

    for (const clip of options.negativeClips) {
      negativeEmbeddings.push(yield* clipEmbeddingFromPcm(sessions, clip));
    }

    const positiveCenter = averageVectors(positiveEmbeddings);
    const negativeCenter = averageVectors(negativeEmbeddings);

    if (positiveCenter.length === 0 || negativeCenter.length === 0) {
      return yield* new WakewordTrainingError({
        message: "Failed to compute training embeddings",
      });
    }

    const weights = new Float32Array(positiveCenter.length);
    for (let index = 0; index < weights.length; index += 1) {
      weights[index] = (positiveCenter[index] ?? 0) - (negativeCenter[index] ?? 0);
    }

    const bias = -0.5 * (dot(weights, positiveCenter) + dot(weights, negativeCenter));

    const positiveRawScores = positiveEmbeddings.map((embedding) => dot(weights, embedding) + bias);
    const negativeRawScores = negativeEmbeddings.map((embedding) => dot(weights, embedding) + bias);

    const logitScale = resolveLogitScale(positiveRawScores, negativeRawScores, bias);

    const positiveScores = positiveRawScores.map((raw) => sigmoid(raw / logitScale));
    const negativeScores = negativeRawScores.map((raw) => sigmoid(raw / logitScale));

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
    };
  });

export const saveTrainedWakewordModel = (
  outputPath: string,
  model: TrainedLinearWakewordModel,
): Effect.Effect<void, WakewordTrainingError> =>
  Effect.tryPromise({
    try: async () => {
      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await fs.writeFile(outputPath, `${JSON.stringify(model, null, 2)}\n`, "utf8");
    },
    catch: (cause) =>
      new WakewordTrainingError({
        message: `Failed to save trained wakeword model to ${outputPath}`,
        cause,
      }),
  });
