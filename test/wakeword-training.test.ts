import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import {
  initializeWakewordTrainingWorkspace,
  makeWakewordTrainingPlan,
  registerWakewordModelInManifest,
} from "../src/wakeword/training.ts";

describe("wakeword training workflow", () => {
  test("builds normalized training plan", () => {
    const plan = makeWakewordTrainingPlan({
      name: "Hey Jarvis.onnx",
      assetRootDir: "/tmp/effect-pi-openwakeword",
    });

    expect(plan.modelName).toBe("hey_jarvis");
    expect(plan.outputModelFileName).toBe("hey_jarvis.json");
    expect(plan.workspaceDir).toContain("training/hey_jarvis");
  });

  test("creates workspace directories and readme", async () => {
    const assetRoot = await fs.mkdtemp(path.join(tmpdir(), "effect-pi-train-"));
    const plan = makeWakewordTrainingPlan({
      name: "custom-word",
      assetRootDir: assetRoot,
    });

    await Effect.runPromise(initializeWakewordTrainingWorkspace(plan));

    const positiveStat = await fs.stat(plan.positiveDir);
    const negativeStat = await fs.stat(plan.negativeDir);
    const testStat = await fs.stat(plan.testDir);
    const readme = await fs.readFile(path.join(plan.workspaceDir, "README.md"), "utf8");

    expect(positiveStat.isDirectory()).toBeTrue();
    expect(negativeStat.isDirectory()).toBeTrue();
    expect(testStat.isDirectory()).toBeTrue();
    expect(readme).toContain("custom-word");
  });

  test("registers model once in manifest", async () => {
    const assetRoot = await fs.mkdtemp(path.join(tmpdir(), "effect-pi-manifest-"));
    const manifestPath = path.join(assetRoot, "manifest.json");

    await fs.writeFile(
      manifestPath,
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
            wakewords: ["existing.json"],
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const first = await Effect.runPromise(
      registerWakewordModelInManifest(manifestPath, "custom.json"),
    );
    const second = await Effect.runPromise(
      registerWakewordModelInManifest(manifestPath, "custom.json"),
    );

    const saved = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
      readonly models: { readonly wakewords: ReadonlyArray<string> };
    };

    expect(first).toBeTrue();
    expect(second).toBeFalse();
    expect(saved.models.wakewords).toEqual(["existing.json", "custom.json"]);
  });
});
