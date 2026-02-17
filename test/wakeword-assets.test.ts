import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { validateWakewordAssets } from "../src/wakeword/assets.ts";

const writeModelFile = async (filePath: string): Promise<void> => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const data = new Uint8Array(8_192);
  for (let index = 0; index < data.length; index += 1) {
    data[index] = index % 251;
  }
  await fs.writeFile(filePath, data);
};

const createValidAssetTree = async (): Promise<string> => {
  const rootDir = await fs.mkdtemp(path.join(tmpdir(), "effect-pi-wakeword-assets-"));

  await fs.writeFile(
    path.join(rootDir, "manifest.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        runtime: {
          package: "onnxruntime-web",
          version: "1.22.0",
        },
        models: {
          melspectrogram: "melspectrogram.onnx",
          embedding: "embedding_model.onnx",
          wakewords: ["jarvis.onnx"],
        },
      },
      null,
      2,
    ),
  );

  await writeModelFile(path.join(rootDir, "melspectrogram.onnx"));
  await writeModelFile(path.join(rootDir, "embedding_model.onnx"));
  await writeModelFile(path.join(rootDir, "wakewords", "jarvis.onnx"));

  return rootDir;
};

describe("wakeword assets", () => {
  test("validates a complete asset tree", async () => {
    const rootDir = await createValidAssetTree();

    const resolved = await Effect.runPromise(
      validateWakewordAssets({
        rootDir,
        validateRuntime: false,
      }),
    );

    expect(Object.keys(resolved.wakewordModelPaths)).toEqual(["jarvis"]);
    expect(resolved.melspectrogramModelPath.endsWith("melspectrogram.onnx")).toBeTrue();
  });

  test("fails when a required model file is missing", async () => {
    const rootDir = await createValidAssetTree();
    await fs.rm(path.join(rootDir, "embedding_model.onnx"));

    const run = Effect.runPromise(
      validateWakewordAssets({
        rootDir,
        validateRuntime: false,
      }),
    );

    await expect(run).rejects.toThrow("Missing or invalid model asset");
  });

  test("fails when feature model is placeholder text", async () => {
    const rootDir = await createValidAssetTree();
    await fs.writeFile(
      path.join(rootDir, "melspectrogram.onnx"),
      "effect-pi placeholder feature model file",
      "utf8",
    );

    const run = Effect.runPromise(
      validateWakewordAssets({
        rootDir,
        validateRuntime: false,
      }),
    );

    await expect(run).rejects.toThrow("Install real openWakeWord ONNX feature models");
  });
});
