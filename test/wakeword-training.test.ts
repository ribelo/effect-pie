import { describe, test } from "node:test"
import * as assert from "node:assert/strict"
import * as Effect from "effect/Effect"
import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"

import {
  initializeWakewordTrainingWorkspace,
  makeWakewordTrainingPlan,
  registerWakewordModelInManifest,
} from "../src/wakeword/training.ts"

describe("wakeword training workflow", () => {
  test("builds normalized training plan", () => {
    const plan = makeWakewordTrainingPlan({
      name: "Hey Jarvis.onnx",
      assetRootDir: "/tmp/pie-openwakeword",
    })

    assert.strictEqual(plan.modelName, "hey_jarvis")
    assert.strictEqual(plan.outputModelFileName, "hey_jarvis.json")
    assert.ok(plan.workspaceDir.includes("training/hey_jarvis"))
  })

  test("creates workspace directories and readme", async () => {
    const assetRoot = await fs.mkdtemp(path.join(tmpdir(), "pie-train-"))
    const plan = makeWakewordTrainingPlan({
      name: "custom-word",
      assetRootDir: assetRoot,
    })

    await Effect.runPromise(initializeWakewordTrainingWorkspace(plan))

    const positiveStat = await fs.stat(plan.positiveDir)
    const negativeStat = await fs.stat(plan.negativeDir)
    const testStat = await fs.stat(plan.testDir)
    const readme = await fs.readFile(path.join(plan.workspaceDir, "README.md"), "utf8")

    assert.strictEqual(positiveStat.isDirectory(), true)
    assert.strictEqual(negativeStat.isDirectory(), true)
    assert.strictEqual(testStat.isDirectory(), true)
    assert.ok(readme.includes("custom-word"))
  })

  test("registers model once in manifest", async () => {
    const assetRoot = await fs.mkdtemp(path.join(tmpdir(), "pie-manifest-"))
    const manifestPath = path.join(assetRoot, "manifest.json")

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
    )

    const first = await Effect.runPromise(
      registerWakewordModelInManifest(manifestPath, "custom.json"),
    )
    const second = await Effect.runPromise(
      registerWakewordModelInManifest(manifestPath, "custom.json"),
    )

    const saved = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
      readonly models: { readonly wakewords: ReadonlyArray<string> }
    }

    assert.strictEqual(first, true)
    assert.strictEqual(second, false)
    assert.deepStrictEqual(saved.models.wakewords, ["existing.json", "custom.json"])
  })
})
