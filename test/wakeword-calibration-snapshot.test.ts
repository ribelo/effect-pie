import { test } from "node:test"
import * as assert from "node:assert/strict"
import { Cause, Effect, Exit } from "effect"
import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"

import { readCalibrationSnapshot } from "../src/commands/wakewordHelpers.ts"

test("readCalibrationSnapshot returns undefined only when the file is missing", async () => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "pie-calibration-missing-"))
  const snapshot = await Effect.runPromise(readCalibrationSnapshot(path.join(dir, "missing.json")))

  assert.strictEqual(snapshot, undefined)
})

test("readCalibrationSnapshot fails with a typed error for malformed JSON", async () => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "pie-calibration-json-"))
  const snapshotPath = path.join(dir, "calibration.json")
  await fs.writeFile(snapshotPath, "not json", "utf8")

  const exit = await Effect.runPromiseExit(readCalibrationSnapshot(snapshotPath))

  assert.strictEqual(Exit.isFailure(exit), true)
  if (Exit.isFailure(exit)) {
    assert.strictEqual(Cause.hasFails(exit.cause), true)
    assert.strictEqual(Cause.hasDies(exit.cause), false)
  }
})

test("readCalibrationSnapshot fails with a typed error for invalid schema", async () => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "pie-calibration-schema-"))
  const snapshotPath = path.join(dir, "calibration.json")
  await fs.writeFile(snapshotPath, JSON.stringify({ schemaVersion: 1 }), "utf8")

  const exit = await Effect.runPromiseExit(readCalibrationSnapshot(snapshotPath))

  assert.strictEqual(Exit.isFailure(exit), true)
  if (Exit.isFailure(exit)) {
    assert.strictEqual(Cause.hasFails(exit.cause), true)
    assert.strictEqual(Cause.hasDies(exit.cause), false)
  }
})
