import { test } from "node:test"
import * as assert from "node:assert/strict"
import { Effect, Ref } from "effect"

import {
  setAssistantRecordingEnabled,
  setAssistantRecordingMode,
  type AssistantRecordingRuntimeState,
} from "../src/commands/assistant/recordingState.js"

test("setAssistantRecordingEnabled updates enabled without changing mode", async () => {
  const ref = await Effect.runPromise(
    Ref.make<AssistantRecordingRuntimeState>({
      enabled: true,
      mode: undefined,
      startedAtMs: undefined,
    }),
  )

  await Effect.runPromise(setAssistantRecordingEnabled({ ref, enabled: false }))

  const state = await Effect.runPromise(Ref.get(ref))
  assert.strictEqual(state.enabled, false)
  assert.strictEqual(state.mode, undefined)

  await Effect.runPromise(setAssistantRecordingEnabled({ ref, enabled: true }))

  const state2 = await Effect.runPromise(Ref.get(ref))
  assert.strictEqual(state2.enabled, true)
})

test("setAssistantRecordingMode preserves enabled flag", async () => {
  const ref = await Effect.runPromise(
    Ref.make<AssistantRecordingRuntimeState>({
      enabled: false,
      mode: undefined,
      startedAtMs: undefined,
    }),
  )

  await Effect.runPromise(setAssistantRecordingMode({ ref, mode: "ptt-transcribe" }))

  const state = await Effect.runPromise(Ref.get(ref))
  assert.strictEqual(state.enabled, false)
  assert.strictEqual(state.mode, "ptt-transcribe")

  await Effect.runPromise(setAssistantRecordingMode({ ref, mode: undefined }))

  const state2 = await Effect.runPromise(Ref.get(ref))
  assert.strictEqual(state2.enabled, false)
  assert.strictEqual(state2.mode, undefined)
})
