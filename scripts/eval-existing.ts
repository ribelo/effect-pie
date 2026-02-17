import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as Effect from "effect/Effect";

import { EFFECT_PI_OPENWAKEWORD_DATA_DIR } from "../src/paths.ts";
import { validateWakewordAssets } from "../src/wakeword/assets.ts";
import { OPENWAKEWORD_MEL_BINS, OPENWAKEWORD_MEL_WINDOW_FRAMES } from "../src/wakeword/defs.ts";
import { loadWakewordFeatureSessions, type WakewordFeatureSessions } from "../src/wakeword/onnx.ts";
import { saveTrainedWakewordModel, trainLinearWakewordModel } from "../src/wakeword/training.ts";

const modelName = process.argv[2] ?? "ok_pie";
const assetRoot = path.resolve(process.env.EFFECT_PI_ASSET_ROOT ?? EFFECT_PI_OPENWAKEWORD_DATA_DIR);
const workspace = path.join(assetRoot, "training", modelName);

const readWavPcm = async (filePath: string): Promise<Uint8Array> => {
  const data = new Uint8Array(await fs.readFile(filePath));
  if (data.length <= 44) {
    throw new Error(`Invalid WAV file: ${filePath}`);
  }
  return data.slice(44);
};

const readClips = async (dir: string): Promise<Array<Uint8Array>> => {
  const entries = (await fs.readdir(dir)).filter((entry) => entry.endsWith(".wav")).sort();
  const clips: Array<Uint8Array> = [];

  for (const entry of entries) {
    clips.push(await readWavPcm(path.join(dir, entry)));
  }

  return clips;
};

const toInt16 = (pcm: Uint8Array): Int16Array => {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const samples = new Int16Array(Math.floor(pcm.byteLength / 2));
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = view.getInt16(index * 2, true);
  }
  return samples;
};

const toFrameMatrix = (data: Float32Array, width: number): Array<Float32Array> => {
  const frameCount = Math.floor(data.length / width);
  const frames: Array<Float32Array> = [];
  for (let frame = 0; frame < frameCount; frame += 1) {
    const start = frame * width;
    frames.push(data.slice(start, start + width));
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

const averageVectors = (vectors: ReadonlyArray<Float32Array>): Float32Array => {
  if (vectors.length === 0) {
    return new Float32Array();
  }

  const out = new Float32Array(vectors[0]?.length ?? 0);
  for (const vector of vectors) {
    for (let index = 0; index < out.length; index += 1) {
      out[index] += vector[index] ?? 0;
    }
  }
  for (let index = 0; index < out.length; index += 1) {
    out[index] /= vectors.length;
  }

  return out;
};

const transformMelspectrogram = (data: Float32Array): Float32Array => {
  const out = new Float32Array(data.length);
  for (let index = 0; index < data.length; index += 1) {
    out[index] = data[index] / 10 + 2;
  }
  return out;
};

const clipEmbedding = (
  sessions: WakewordFeatureSessions,
  pcm: Uint8Array,
): Effect.Effect<Float32Array> =>
  Effect.gen(function* () {
    const samples = toInt16(pcm);
    const melInput = Float32Array.from(samples);

    const mel = yield* sessions.melspectrogram
      .run({
        data: melInput,
        dims: [1, melInput.length],
      })
      .pipe(Effect.map((output) => transformMelspectrogram(output.data)));

    const melFrames = toFrameMatrix(mel, OPENWAKEWORD_MEL_BINS);
    const windows: Array<Float32Array> = [];

    for (let start = 0; start + OPENWAKEWORD_MEL_WINDOW_FRAMES <= melFrames.length; start += 8) {
      const window = melFrames.slice(start, start + OPENWAKEWORD_MEL_WINDOW_FRAMES);
      const input = flattenMatrix(window);

      const embedding = yield* sessions.embedding.run({
        data: input,
        dims: [1, OPENWAKEWORD_MEL_WINDOW_FRAMES, OPENWAKEWORD_MEL_BINS, 1],
      });
      windows.push(embedding.data);
    }

    if (windows.length === 0) {
      const padded = [
        ...Array.from(
          { length: Math.max(0, OPENWAKEWORD_MEL_WINDOW_FRAMES - melFrames.length) },
          () => Float32Array.from({ length: OPENWAKEWORD_MEL_BINS }, () => 1),
        ),
        ...melFrames,
      ].slice(-OPENWAKEWORD_MEL_WINDOW_FRAMES);

      const input = flattenMatrix(padded);
      const embedding = yield* sessions.embedding.run({
        data: input,
        dims: [1, OPENWAKEWORD_MEL_WINDOW_FRAMES, OPENWAKEWORD_MEL_BINS, 1],
      });
      windows.push(embedding.data);
    }

    return averageVectors(windows);
  });

const scoreEmbedding = (
  weights: ReadonlyArray<number>,
  bias: number,
  logitScale: number,
  embedding: Float32Array,
): number => {
  let rawScore = bias;
  const length = Math.min(weights.length, embedding.length);
  for (let index = 0; index < length; index += 1) {
    rawScore += (weights[index] ?? 0) * (embedding[index] ?? 0);
  }
  return 1 / (1 + Math.exp(-(rawScore / logitScale)));
};

const summarize = (name: string, values: ReadonlyArray<number>): void => {
  const mean = values.reduce((acc, v) => acc + v, 0) / Math.max(1, values.length);
  const min = values.reduce((acc, v) => (v < acc ? v : acc), Number.POSITIVE_INFINITY);
  const max = values.reduce((acc, v) => (v > acc ? v : acc), Number.NEGATIVE_INFINITY);
  console.log(`${name}: mean=${mean.toFixed(4)} min=${min.toFixed(4)} max=${max.toFixed(4)}`);
};

const positiveAll = await readClips(path.join(workspace, "positive"));
const negativeAll = await readClips(path.join(workspace, "negative"));

const positiveSplit = Math.max(1, Math.floor(positiveAll.length * 0.75));
const negativeSplit = Math.max(1, Math.floor(negativeAll.length * 0.75));

const trainPos = positiveAll.slice(0, positiveSplit);
const testPos = positiveAll.slice(positiveSplit);
const trainNeg = negativeAll.slice(0, negativeSplit);
const testNeg = negativeAll.slice(negativeSplit);

if (testPos.length === 0 || testNeg.length === 0) {
  throw new Error("Need enough clips for holdout evaluation");
}

const { model, outputPath, featureSessions } = await Effect.runPromise(
  Effect.gen(function* () {
    const assets = yield* validateWakewordAssets({
      rootDir: assetRoot,
      validateWakewordModels: false,
    });
    const sessions = yield* loadWakewordFeatureSessions(assets);

    const trained = yield* trainLinearWakewordModel(sessions, {
      positiveClips: trainPos,
      negativeClips: trainNeg,
    });

    const targetPath = path.join(assetRoot, "wakewords", `${modelName}.json`);
    yield* saveTrainedWakewordModel(targetPath, trained);

    return {
      model: trained,
      outputPath: targetPath,
      featureSessions: sessions,
    };
  }),
);

const evalPosScores: Array<number> = [];
const evalNegScores: Array<number> = [];

for (const clip of testPos) {
  const embedding = await Effect.runPromise(clipEmbedding(featureSessions, clip));
  evalPosScores.push(scoreEmbedding(model.weights, model.bias, model.logitScale, embedding));
}
for (const clip of testNeg) {
  const embedding = await Effect.runPromise(clipEmbedding(featureSessions, clip));
  evalNegScores.push(scoreEmbedding(model.weights, model.bias, model.logitScale, embedding));
}

const threshold = 0.5;
const falseRejectRate =
  evalPosScores.filter((score) => score < threshold).length / Math.max(1, evalPosScores.length);
const falseAcceptRate =
  evalNegScores.filter((score) => score >= threshold).length / Math.max(1, evalNegScores.length);

const separation = model.metrics.positiveMean - model.metrics.negativeMean;

console.log(`Model: ${modelName}`);
console.log(`Output: ${outputPath}`);
console.log(`train_positive=${trainPos.length} train_negative=${trainNeg.length}`);
console.log(`test_positive=${testPos.length} test_negative=${testNeg.length}`);
console.log(`train_positive_mean=${model.metrics.positiveMean.toFixed(4)}`);
console.log(`train_negative_mean=${model.metrics.negativeMean.toFixed(4)}`);
console.log(`train_separation=${separation.toFixed(4)}`);
console.log(`logit_scale=${model.logitScale.toFixed(4)}`);
summarize("test_positive_scores", evalPosScores);
summarize("test_negative_scores", evalNegScores);
console.log(
  `threshold=${threshold.toFixed(2)} false_reject_rate=${falseRejectRate.toFixed(4)} false_accept_rate=${falseAcceptRate.toFixed(4)}`,
);

const usable = falseRejectRate <= 0.15 && falseAcceptRate <= 0.15;
console.log(`usable=${usable}`);
