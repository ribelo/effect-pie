import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as Effect from "effect/Effect";

import { validateWakewordAssets } from "../src/wakeword/assets.ts";
import { loadWakewordFeatureSessions } from "../src/wakeword/onnx.ts";
import { saveTrainedWakewordModel, trainLinearWakewordModel } from "../src/wakeword/training.ts";

const modelName = process.argv[2] ?? "ok_pie";
const assetRoot = path.resolve(process.cwd(), "assets", "openwakeword");
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

const positiveClips = await readClips(path.join(workspace, "positive"));
const negativeClips = await readClips(path.join(workspace, "negative"));

const model = await Effect.runPromise(
  Effect.gen(function* () {
    const assets = yield* validateWakewordAssets({
      rootDir: assetRoot,
      validateWakewordModels: false,
    });
    const featureSessions = yield* loadWakewordFeatureSessions(assets);
    const trained = yield* trainLinearWakewordModel(featureSessions, {
      positiveClips,
      negativeClips,
    });

    const outputPath = path.join(assetRoot, "wakewords", `${modelName}.json`);
    yield* saveTrainedWakewordModel(outputPath, trained);

    return {
      trained,
      outputPath,
    };
  }),
);

const separation = model.trained.metrics.positiveMean - model.trained.metrics.negativeMean;
const usable = separation >= 0.08 && model.trained.metrics.positiveMean >= 0.6;

console.log(`Model: ${modelName}`);
console.log(`Output: ${model.outputPath}`);
console.log(`positive_mean=${model.trained.metrics.positiveMean.toFixed(4)}`);
console.log(`negative_mean=${model.trained.metrics.negativeMean.toFixed(4)}`);
console.log(`positive_std=${model.trained.metrics.positiveStdDev.toFixed(4)}`);
console.log(`negative_std=${model.trained.metrics.negativeStdDev.toFixed(4)}`);
console.log(`logit_scale=${model.trained.logitScale.toFixed(4)}`);
console.log(`separation=${separation.toFixed(4)}`);
console.log(`usable=${usable}`);
