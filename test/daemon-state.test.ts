import { test } from "node:test"
import * as assert from "node:assert/strict"
import { Effect, Ref } from "effect"

import {
  setAssistantRecordingEnabled,
  setAssistantRecordingMode,
  tryStartRecording,
  stopRecording,
  setRecordingError,
  getRecordingState,
  type AssistantRecordingRuntimeState,
} from "../src/commands/assistant/recordingState.js"

const makeRef = (runtime: Partial<AssistantRecordingRuntimeState> = {}) =>
  Ref.make<AssistantRecordingRuntimeState>({
    enabled: true,
    mode: undefined,
    startedAtMs: undefined,
    transcriptPath: undefined,
    lastError: undefined,
    updatedAt: new Date().toISOString(),
    ...runtime,
  })

test("setAssistantRecordingEnabled updates enabled without changing mode", async () => {
  const ref = await Effect.runPromise(makeRef())

  await Effect.runPromise(setAssistantRecordingEnabled({ ref, enabled: false }))

  const state = await Effect.runPromise(Ref.get(ref))
  assert.strictEqual(state.enabled, false)
  assert.strictEqual(state.mode, undefined)

  await Effect.runPromise(setAssistantRecordingEnabled({ ref, enabled: true }))

  const state2 = await Effect.runPromise(Ref.get(ref))
  assert.strictEqual(state2.enabled, true)
})

test("setAssistantRecordingMode preserves enabled flag", async () => {
  const ref = await Effect.runPromise(makeRef({ enabled: false }))

  await Effect.runPromise(setAssistantRecordingMode({ ref, mode: "ptt-transcribe" }))

  const state = await Effect.runPromise(Ref.get(ref))
  assert.strictEqual(state.enabled, false)
  assert.strictEqual(state.mode, "ptt-transcribe")

  await Effect.runPromise(setAssistantRecordingMode({ ref, mode: undefined }))

  const state2 = await Effect.runPromise(Ref.get(ref))
  assert.strictEqual(state2.enabled, false)
  assert.strictEqual(state2.mode, undefined)
})

test("tryStartRecording succeeds when idle", async () => {
  const ref = await Effect.runPromise(makeRef())

  const result = await Effect.runPromise(tryStartRecording({ ref, mode: "ptt-transcribe" }))

  assert.strictEqual(result["_tag"], "Started")
  assert.strictEqual(result.mode, "ptt-transcribe")

  const state = await Effect.runPromise(Ref.get(ref))
  assert.strictEqual(state.mode, "ptt-transcribe")
  assert.strictEqual(state.enabled, true)
})

test("tryStartRecording returns Busy when another mode is active", async () => {
  const ref = await Effect.runPromise(makeRef({ mode: "ptt-transcribe", startedAtMs: Date.now() }))

  const result = await Effect.runPromise(tryStartRecording({ ref, mode: "wakeword" }))

  assert.strictEqual(result["_tag"], "Busy")
  assert.strictEqual(result.activeMode, "ptt-transcribe")
})

test("tryStartRecording returns Disabled when disabled", async () => {
  const ref = await Effect.runPromise(makeRef({ enabled: false }))

  const result = await Effect.runPromise(tryStartRecording({ ref, mode: "ptt-transcribe" }))

  assert.strictEqual(result["_tag"], "Disabled")
})

test("stopRecording clears state when owner matches", async () => {
  const ref = await Effect.runPromise(makeRef({ mode: "ptt-transcribe", startedAtMs: Date.now() }))

  const didStop = await Effect.runPromise(stopRecording({ ref, mode: "ptt-transcribe" }))

  assert.strictEqual(didStop, true)

  const state = await Effect.runPromise(Ref.get(ref))
  assert.strictEqual(state.mode, undefined)
})

test("stopRecording returns false when mode does not match", async () => {
  const ref = await Effect.runPromise(makeRef({ mode: "ptt-transcribe", startedAtMs: Date.now() }))

  const didStop = await Effect.runPromise(stopRecording({ ref, mode: "wakeword" }))

  assert.strictEqual(didStop, false)

  const state = await Effect.runPromise(Ref.get(ref))
  assert.strictEqual(state.mode, "ptt-transcribe")
})

test("tryStartRecording persists transcriptPath", async () => {
  const ref = await Effect.runPromise(makeRef())

  const result = await Effect.runPromise(
    tryStartRecording({ ref, mode: "meeting-transcribe", transcriptPath: "/tmp/meeting.txt" }),
  )

  assert.strictEqual(result["_tag"], "Started")

  const state = await Effect.runPromise(Ref.get(ref))
  assert.strictEqual(state.transcriptPath, "/tmp/meeting.txt")
})

test("setRecordingError persists lastError", async () => {
  const ref = await Effect.runPromise(makeRef())

  await Effect.runPromise(setRecordingError({ ref, lastError: "mic disconnected" }))

  const state = await Effect.runPromise(Ref.get(ref))
  assert.strictEqual(state.lastError, "mic disconnected")
})

test("getRecordingState derives active and mode from runtime", async () => {
  const ref = await Effect.runPromise(
    makeRef({ mode: "wakeword", startedAtMs: 1_700_000_000_000, lastError: "previous failure" }),
  )

  const state = await Effect.runPromise(getRecordingState({ ref }))

  assert.strictEqual(state.enabled, true)
  assert.strictEqual(state.active, true)
  assert.strictEqual(state.mode, "wakeword")
  assert.strictEqual(state.startedAt, new Date(1_700_000_000_000).toISOString())
  assert.strictEqual(state.lastError, "previous failure")
})

test("getRecordingState returns stable updatedAt when runtime is unchanged", async () => {
  const ref = await Effect.runPromise(
    makeRef({ mode: "ptt-transcribe", startedAtMs: 1_700_000_000_000 }),
  )

  const state1 = await Effect.runPromise(getRecordingState({ ref }))
  await new Promise<void>((r) => {
    setTimeout(r, 20)
  })
  const state2 = await Effect.runPromise(getRecordingState({ ref }))

  assert.strictEqual(state1.updatedAt, state2.updatedAt)
})

test("tryStartRecording preserves lastError in Busy path", async () => {
  const ref = await Effect.runPromise(
    makeRef({ mode: "ptt-transcribe", startedAtMs: Date.now(), lastError: "previous error" }),
  )

  const result = await Effect.runPromise(tryStartRecording({ ref, mode: "wakeword" }))

  assert.strictEqual(result["_tag"], "Busy")

  const state = await Effect.runPromise(Ref.get(ref))
  assert.strictEqual(state.lastError, "previous error")
})
