import { test } from "node:test"
import * as assert from "node:assert/strict"

import { AssistantDiagnostics, isShellTraceEnabled } from "../src/assistant/diagnostics.js"

test("isShellTraceEnabled returns false for undefined", () => {
  assert.strictEqual(isShellTraceEnabled(undefined), false)
})

test("isShellTraceEnabled returns false for empty string", () => {
  assert.strictEqual(isShellTraceEnabled(""), false)
})

test("isShellTraceEnabled returns false for whitespace", () => {
  assert.strictEqual(isShellTraceEnabled("   "), false)
})

test("isShellTraceEnabled returns false for unrecognized values", () => {
  assert.strictEqual(isShellTraceEnabled("maybe"), false)
  assert.strictEqual(isShellTraceEnabled("0"), false)
  assert.strictEqual(isShellTraceEnabled("false"), false)
  assert.strictEqual(isShellTraceEnabled("no"), false)
  assert.strictEqual(isShellTraceEnabled("off"), false)
})

test("isShellTraceEnabled returns true for 1", () => {
  assert.strictEqual(isShellTraceEnabled("1"), true)
})

test("isShellTraceEnabled returns true for true case-insensitively", () => {
  assert.strictEqual(isShellTraceEnabled("true"), true)
  assert.strictEqual(isShellTraceEnabled("TRUE"), true)
  assert.strictEqual(isShellTraceEnabled("True"), true)
})

test("isShellTraceEnabled returns true for yes case-insensitively", () => {
  assert.strictEqual(isShellTraceEnabled("yes"), true)
  assert.strictEqual(isShellTraceEnabled("YES"), true)
})

test("isShellTraceEnabled returns true for on case-insensitively", () => {
  assert.strictEqual(isShellTraceEnabled("on"), true)
  assert.strictEqual(isShellTraceEnabled("ON"), true)
})

test("AssistantDiagnostics starts in idle state", () => {
  const diag = new AssistantDiagnostics()
  assert.strictEqual(diag.state, "idle")
})

test("AssistantDiagnostics setState changes state and logs", () => {
  const diag = new AssistantDiagnostics()
  diag.setState("ptt-transcribe")
  assert.strictEqual(diag.state, "ptt-transcribe")
})

test("AssistantDiagnostics renders snapshot with state", () => {
  const diag = new AssistantDiagnostics()
  diag.setState("idle")
  const snapshot = diag.renderSnapshot()
  assert.ok(snapshot.includes("idle"))
  assert.ok(snapshot.includes("Assistant Diagnostics Snapshot"))
})

test("AssistantDiagnostics truncates old entries beyond max", () => {
  const diag = new AssistantDiagnostics(3)
  diag.pttHold("transcribe")
  diag.pttRelease()
  diag.pttFinalize(1000)
  diag.wakewordTrigger("test_model")

  const snapshot = diag.renderSnapshot()
  assert.ok(!snapshot.includes("hold"))
  assert.ok(snapshot.includes("release"))
  assert.ok(snapshot.includes("finalize"))
  assert.ok(snapshot.includes("trigger"))
})

test("AssistantDiagnostics includes all event categories", () => {
  const diag = new AssistantDiagnostics(15)
  diag.setState("ptt-transcribe")
  diag.pttHold("transcribe")
  diag.pttRelease()
  diag.pttFinalize(1200)
  diag.wakewordTrigger("hey_jarvis")
  diag.sttStart("model-a")
  diag.sttComplete(42)
  diag.sttFailure("timeout")
  diag.injectionStart(100)
  diag.injectionComplete()
  diag.injectionFailure("backend unavailable")

  const snapshot = diag.renderSnapshot()
  assert.ok(snapshot.includes("[mode]"))
  assert.ok(snapshot.includes("[ptt]"))
  assert.ok(snapshot.includes("[wakeword]"))
  assert.ok(snapshot.includes("[stt]"))
  assert.ok(snapshot.includes("[injection]"))
})
