import { test } from "node:test"
import * as assert from "node:assert/strict"

import {
  assistantDictationComplete,
  assistantIdle,
  assistantInjectionComplete,
  assistantInjectionFailure,
  assistantInjectionStart,
  assistantPttFinalize,
  assistantPttHold,
  assistantPttRelease,
  assistantShutdown,
  assistantSttComplete,
  assistantSttFailure,
  assistantSttStart,
  assistantWakewordTrigger,
  canAcceptWakewordTrigger,
  canSwitchPttMode,
} from "../src/assistant/state.js"

test("assistantIdle has expected initial state", () => {
  assert.strictEqual(assistantIdle.mode, "idle")
  assert.strictEqual(assistantIdle.pttActive, false)
  assert.strictEqual(assistantIdle.transcribing, false)
  assert.strictEqual(assistantIdle.injecting, false)
})

test("canAcceptWakewordTrigger is true in idle", () => {
  assert.strictEqual(canAcceptWakewordTrigger(assistantIdle), true)
})

test("canAcceptWakewordTrigger is false when pttActive", () => {
  const state = assistantPttHold(assistantIdle, "transcribe")
  assert.strictEqual(canAcceptWakewordTrigger(state), false)
})

test("canAcceptWakewordTrigger is false when transcribing", () => {
  const finalized = assistantPttFinalize(
    assistantPttRelease(assistantPttHold(assistantIdle, "transcribe")),
    1000,
    500,
  )
  const state = assistantSttStart(finalized)
  assert.strictEqual(canAcceptWakewordTrigger(state), false)
})

test("canAcceptWakewordTrigger is false when injecting", () => {
  const finalized = assistantPttFinalize(
    assistantPttRelease(assistantPttHold(assistantIdle, "transcribe")),
    1000,
    500,
  )
  const completed = assistantSttComplete(assistantSttStart(finalized))
  const state = assistantInjectionStart(completed)
  assert.strictEqual(canAcceptWakewordTrigger(state), false)
})

test("canSwitchPttMode allows transcribe from idle", () => {
  assert.strictEqual(canSwitchPttMode(assistantIdle, "transcribe"), true)
})

test("canSwitchPttMode allows translate from idle", () => {
  assert.strictEqual(canSwitchPttMode(assistantIdle, "translate"), true)
})

test("canSwitchPttMode blocks translate switch while transcribe active", () => {
  const state = assistantPttHold(assistantIdle, "transcribe")
  assert.strictEqual(canSwitchPttMode(state, "translate"), false)
})

test("canSwitchPttMode blocks transcribe switch while translate active", () => {
  const state = assistantPttHold(assistantIdle, "translate")
  assert.strictEqual(canSwitchPttMode(state, "transcribe"), false)
})

test("canSwitchPttMode allows same mode while active", () => {
  const state = assistantPttHold(assistantIdle, "transcribe")
  assert.strictEqual(canSwitchPttMode(state, "transcribe"), true)
})

test("assistantPttHold sets mode and pttActive", () => {
  const state = assistantPttHold(assistantIdle, "transcribe")
  assert.strictEqual(state.mode, "ptt-transcribe")
  assert.strictEqual(state.pttActive, true)
})

test("assistantPttHold is no-op when mode switch blocked", () => {
  const active = assistantPttHold(assistantIdle, "transcribe")
  const state = assistantPttHold(active, "translate")
  assert.strictEqual(state.mode, "ptt-transcribe")
})

test("assistantPttRelease clears pttActive", () => {
  const held = assistantPttHold(assistantIdle, "transcribe")
  const state = assistantPttRelease(held)
  assert.strictEqual(state.pttActive, false)
  assert.strictEqual(state.mode, "ptt-transcribe")
})

test("assistantPttRelease is no-op when not active", () => {
  const state = assistantPttRelease(assistantIdle)
  assert.deepStrictEqual(state, assistantIdle)
})

test("assistantPttFinalize returns idle for short clips", () => {
  const held = assistantPttHold(assistantIdle, "transcribe")
  const released = assistantPttRelease(held)
  const state = assistantPttFinalize(released, 100, 500)
  assert.strictEqual(state.mode, "idle")
})

test("assistantPttFinalize transitions to stt for long enough clips", () => {
  const held = assistantPttHold(assistantIdle, "transcribe")
  const released = assistantPttRelease(held)
  const state = assistantPttFinalize(released, 1000, 500)
  assert.strictEqual(state.mode, "stt")
})

test("assistantPttFinalize is no-op when still active", () => {
  const held = assistantPttHold(assistantIdle, "transcribe")
  const state = assistantPttFinalize(held, 1000, 500)
  assert.strictEqual(state.mode, "ptt-transcribe")
})

test("assistantWakewordTrigger transitions to wakeword-dictation from idle", () => {
  const state = assistantWakewordTrigger(assistantIdle)
  assert.strictEqual(state.mode, "wakeword-dictation")
})

test("assistantWakewordTrigger is no-op when ptt active", () => {
  const held = assistantPttHold(assistantIdle, "transcribe")
  const state = assistantWakewordTrigger(held)
  assert.strictEqual(state.mode, "ptt-transcribe")
})

test("assistantDictationComplete transitions to stt", () => {
  const triggered = assistantWakewordTrigger(assistantIdle)
  const state = assistantDictationComplete(triggered)
  assert.strictEqual(state.mode, "stt")
})

test("assistantDictationComplete is no-op from wrong mode", () => {
  const state = assistantDictationComplete(assistantIdle)
  assert.strictEqual(state.mode, "idle")
})

test("assistantSttStart sets transcribing flag", () => {
  const finalized = assistantPttFinalize(
    assistantPttRelease(assistantPttHold(assistantIdle, "transcribe")),
    1000,
    500,
  )
  const state = assistantSttStart(finalized)
  assert.strictEqual(state.transcribing, true)
})

test("assistantSttComplete transitions to injection", () => {
  const finalized = assistantPttFinalize(
    assistantPttRelease(assistantPttHold(assistantIdle, "transcribe")),
    1000,
    500,
  )
  const started = assistantSttStart(finalized)
  const state = assistantSttComplete(started)
  assert.strictEqual(state.mode, "injection")
  assert.strictEqual(state.transcribing, false)
})

test("assistantSttFailure returns to idle", () => {
  const finalized = assistantPttFinalize(
    assistantPttRelease(assistantPttHold(assistantIdle, "transcribe")),
    1000,
    500,
  )
  const started = assistantSttStart(finalized)
  const state = assistantSttFailure(started)
  assert.strictEqual(state.mode, "idle")
  assert.strictEqual(state.transcribing, false)
})

test("assistantSttStart is no-op when not in stt mode", () => {
  const state = assistantSttStart(assistantIdle)
  assert.strictEqual(state.transcribing, false)
})

test("assistantInjectionStart sets injecting flag", () => {
  const finalized = assistantPttFinalize(
    assistantPttRelease(assistantPttHold(assistantIdle, "transcribe")),
    1000,
    500,
  )
  const completed = assistantSttComplete(assistantSttStart(finalized))
  const state = assistantInjectionStart(completed)
  assert.strictEqual(state.injecting, true)
})

test("assistantInjectionComplete returns to idle", () => {
  const finalized = assistantPttFinalize(
    assistantPttRelease(assistantPttHold(assistantIdle, "transcribe")),
    1000,
    500,
  )
  const completed = assistantSttComplete(assistantSttStart(finalized))
  const started = assistantInjectionStart(completed)
  const state = assistantInjectionComplete(started)
  assert.strictEqual(state.mode, "idle")
  assert.strictEqual(state.injecting, false)
})

test("assistantInjectionFailure returns to idle", () => {
  const finalized = assistantPttFinalize(
    assistantPttRelease(assistantPttHold(assistantIdle, "transcribe")),
    1000,
    500,
  )
  const completed = assistantSttComplete(assistantSttStart(finalized))
  const started = assistantInjectionStart(completed)
  const state = assistantInjectionFailure(started)
  assert.strictEqual(state.mode, "idle")
  assert.strictEqual(state.injecting, false)
})

test("assistantShutdown returns idle from any state", () => {
  const held = assistantPttHold(assistantIdle, "transcribe")
  const state = assistantShutdown()
  assert.deepStrictEqual(state, assistantIdle)
})

test("full ptt transcribe flow transitions correctly", () => {
  let state = assistantIdle
  state = assistantPttHold(state, "transcribe")
  assert.strictEqual(state.mode, "ptt-transcribe")
  assert.strictEqual(state.pttActive, true)

  state = assistantPttRelease(state)
  assert.strictEqual(state.pttActive, false)

  state = assistantPttFinalize(state, 1000, 500)
  assert.strictEqual(state.mode, "stt")

  state = assistantSttStart(state)
  assert.strictEqual(state.transcribing, true)

  state = assistantSttComplete(state)
  assert.strictEqual(state.mode, "injection")

  state = assistantInjectionStart(state)
  assert.strictEqual(state.injecting, true)

  state = assistantInjectionComplete(state)
  assert.strictEqual(state.mode, "idle")
  assert.strictEqual(state.injecting, false)
})

test("full wakeword flow transitions correctly", () => {
  let state = assistantIdle
  state = assistantWakewordTrigger(state)
  assert.strictEqual(state.mode, "wakeword-dictation")

  state = assistantDictationComplete(state)
  assert.strictEqual(state.mode, "stt")

  state = assistantSttStart(state)
  state = assistantSttComplete(state)
  state = assistantInjectionStart(state)
  state = assistantInjectionComplete(state)
  assert.strictEqual(state.mode, "idle")
})
