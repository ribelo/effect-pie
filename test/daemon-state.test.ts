import { test } from "node:test"
import * as assert from "node:assert/strict"
import { Effect } from "effect"
import * as os from "node:os"
import * as crypto from "node:crypto"
import * as fs from "node:fs/promises"
import * as path from "node:path"

import { RecordingCoordinator } from "../src/commands/assistant/coordinator.js"

const makeCoordinator = (persistPath: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const c = yield* RecordingCoordinator
      return c
    }).pipe(Effect.provide(RecordingCoordinator.live({ persistPath }))),
  )

test("setEnabled updates enabled without changing mode", async () => {
  const persistPath = path.join(os.tmpdir(), `pie-test-${crypto.randomUUID()}.json`)
  const coordinator = await makeCoordinator(persistPath)

  await Effect.runPromise(coordinator.setEnabled(false))

  const state = await Effect.runPromise(coordinator.snapshot)
  assert.strictEqual(state.enabled, false)
  assert.strictEqual(state.mode, "idle")

  await Effect.runPromise(coordinator.setEnabled(true))

  const state2 = await Effect.runPromise(coordinator.snapshot)
  assert.strictEqual(state2.enabled, true)

  await fs.unlink(persistPath).catch(() => {})
})

test("clear preserves enabled flag", async () => {
  const persistPath = path.join(os.tmpdir(), `pie-test-${crypto.randomUUID()}.json`)
  const coordinator = await makeCoordinator(persistPath)

  await Effect.runPromise(coordinator.setEnabled(false))
  await Effect.runPromise(coordinator.clear)

  const state = await Effect.runPromise(coordinator.snapshot)
  assert.strictEqual(state.enabled, false)
  assert.strictEqual(state.mode, "idle")

  await fs.unlink(persistPath).catch(() => {})
})

test("tryStart succeeds when idle", async () => {
  const persistPath = path.join(os.tmpdir(), `pie-test-${crypto.randomUUID()}.json`)
  const coordinator = await makeCoordinator(persistPath)

  const result = await Effect.runPromise(coordinator.tryStart("ptt-transcribe"))

  assert.strictEqual(result["_tag"], "Started")
  assert.strictEqual(result.mode, "ptt-transcribe")

  const state = await Effect.runPromise(coordinator.snapshot)
  assert.strictEqual(state.mode, "ptt-transcribe")
  assert.strictEqual(state.enabled, true)
  assert.strictEqual(state.active, true)

  await fs.unlink(persistPath).catch(() => {})
})

test("tryStart returns Busy when another mode is active", async () => {
  const persistPath = path.join(os.tmpdir(), `pie-test-${crypto.randomUUID()}.json`)
  const coordinator = await makeCoordinator(persistPath)

  await Effect.runPromise(coordinator.tryStart("ptt-transcribe"))

  const result = await Effect.runPromise(coordinator.tryStart("wakeword"))

  assert.strictEqual(result["_tag"], "Busy")
  assert.strictEqual(result.activeMode, "ptt-transcribe")

  await fs.unlink(persistPath).catch(() => {})
})

test("tryStart returns Disabled when disabled", async () => {
  const persistPath = path.join(os.tmpdir(), `pie-test-${crypto.randomUUID()}.json`)
  const coordinator = await makeCoordinator(persistPath)

  await Effect.runPromise(coordinator.setEnabled(false))

  const result = await Effect.runPromise(coordinator.tryStart("ptt-transcribe"))

  assert.strictEqual(result["_tag"], "Disabled")

  await fs.unlink(persistPath).catch(() => {})
})

test("stop clears state when owner matches", async () => {
  const persistPath = path.join(os.tmpdir(), `pie-test-${crypto.randomUUID()}.json`)
  const coordinator = await makeCoordinator(persistPath)

  await Effect.runPromise(coordinator.tryStart("ptt-transcribe"))
  const didStop = await Effect.runPromise(coordinator.stop("ptt-transcribe"))

  assert.strictEqual(didStop, true)

  const state = await Effect.runPromise(coordinator.snapshot)
  assert.strictEqual(state.mode, "idle")
  assert.strictEqual(state.active, false)

  await fs.unlink(persistPath).catch(() => {})
})

test("stop returns false when mode does not match", async () => {
  const persistPath = path.join(os.tmpdir(), `pie-test-${crypto.randomUUID()}.json`)
  const coordinator = await makeCoordinator(persistPath)

  await Effect.runPromise(coordinator.tryStart("ptt-transcribe"))
  const didStop = await Effect.runPromise(coordinator.stop("wakeword"))

  assert.strictEqual(didStop, false)

  const state = await Effect.runPromise(coordinator.snapshot)
  assert.strictEqual(state.mode, "ptt-transcribe")

  await fs.unlink(persistPath).catch(() => {})
})

test("tryStart persists transcriptPath", async () => {
  const persistPath = path.join(os.tmpdir(), `pie-test-${crypto.randomUUID()}.json`)
  const coordinator = await makeCoordinator(persistPath)

  const result = await Effect.runPromise(
    coordinator.tryStart("meeting-transcribe", { transcriptPath: "/tmp/meeting.txt" }),
  )

  assert.strictEqual(result["_tag"], "Started")

  const state = await Effect.runPromise(coordinator.snapshot)
  assert.strictEqual(state.transcriptPath, "/tmp/meeting.txt")

  await fs.unlink(persistPath).catch(() => {})
})

test("setError persists lastError", async () => {
  const persistPath = path.join(os.tmpdir(), `pie-test-${crypto.randomUUID()}.json`)
  const coordinator = await makeCoordinator(persistPath)

  await Effect.runPromise(coordinator.setError("mic disconnected"))

  const state = await Effect.runPromise(coordinator.snapshot)
  assert.strictEqual(state.lastError, "mic disconnected")

  await fs.unlink(persistPath).catch(() => {})
})

test("snapshot derives active and mode from internal state", async () => {
  const persistPath = path.join(os.tmpdir(), `pie-test-${crypto.randomUUID()}.json`)
  const coordinator = await makeCoordinator(persistPath)

  await Effect.runPromise(coordinator.tryStart("wakeword"))
  await Effect.runPromise(coordinator.setError("previous failure"))

  const state = await Effect.runPromise(coordinator.snapshot)

  assert.strictEqual(state.enabled, true)
  assert.strictEqual(state.active, true)
  assert.strictEqual(state.mode, "wakeword")
  assert.strictEqual(state.lastError, "previous failure")

  await fs.unlink(persistPath).catch(() => {})
})

test("snapshot returns stable updatedAt when state is unchanged", async () => {
  const persistPath = path.join(os.tmpdir(), `pie-test-${crypto.randomUUID()}.json`)
  const coordinator = await makeCoordinator(persistPath)

  await Effect.runPromise(coordinator.tryStart("ptt-transcribe"))
  const state1 = await Effect.runPromise(coordinator.snapshot)
  await new Promise<void>((r) => {
    setTimeout(r, 20)
  })
  const state2 = await Effect.runPromise(coordinator.snapshot)

  assert.strictEqual(state1.updatedAt, state2.updatedAt)

  await fs.unlink(persistPath).catch(() => {})
})

test("tryStart preserves lastError in Busy path", async () => {
  const persistPath = path.join(os.tmpdir(), `pie-test-${crypto.randomUUID()}.json`)
  const coordinator = await makeCoordinator(persistPath)

  await Effect.runPromise(coordinator.tryStart("ptt-transcribe"))
  await Effect.runPromise(coordinator.setError("previous error"))

  const result = await Effect.runPromise(coordinator.tryStart("wakeword"))

  assert.strictEqual(result["_tag"], "Busy")

  const state = await Effect.runPromise(coordinator.snapshot)
  assert.strictEqual(state.lastError, "previous error")

  await fs.unlink(persistPath).catch(() => {})
})

test("snapshot matches persisted JSON", async () => {
  const persistPath = path.join(os.tmpdir(), `pie-test-${crypto.randomUUID()}.json`)
  const coordinator = await makeCoordinator(persistPath)

  await Effect.runPromise(coordinator.tryStart("ptt-transcribe"))
  const snapshot = await Effect.runPromise(coordinator.snapshot)

  const raw = await fs.readFile(persistPath, "utf8")
  const parsed = JSON.parse(raw)

  assert.deepStrictEqual(parsed, snapshot)

  await fs.unlink(persistPath).catch(() => {})
})

test("toggleEnabled flips enabled and returns new value", async () => {
  const persistPath = path.join(os.tmpdir(), `pie-test-${crypto.randomUUID()}.json`)
  const coordinator = await makeCoordinator(persistPath)

  const v1 = await Effect.runPromise(coordinator.toggleEnabled)
  assert.strictEqual(v1, false)

  const v2 = await Effect.runPromise(coordinator.toggleEnabled)
  assert.strictEqual(v2, true)

  await fs.unlink(persistPath).catch(() => {})
})

test("toggleMeeting starts when idle and enabled", async () => {
  const persistPath = path.join(os.tmpdir(), `pie-test-${crypto.randomUUID()}.json`)
  const coordinator = await makeCoordinator(persistPath)

  const state = await Effect.runPromise(coordinator.toggleMeeting)
  assert.strictEqual(state.mode, "meeting-transcribe")
  assert.strictEqual(state.active, true)

  await fs.unlink(persistPath).catch(() => {})
})

test("toggleMeeting stops when already in meeting mode", async () => {
  const persistPath = path.join(os.tmpdir(), `pie-test-${crypto.randomUUID()}.json`)
  const coordinator = await makeCoordinator(persistPath)

  await Effect.runPromise(coordinator.toggleMeeting)
  const state = await Effect.runPromise(coordinator.toggleMeeting)
  assert.strictEqual(state.mode, "idle")
  assert.strictEqual(state.active, false)

  await fs.unlink(persistPath).catch(() => {})
})
