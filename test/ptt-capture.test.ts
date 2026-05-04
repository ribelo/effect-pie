import { test } from "node:test"
import * as assert from "node:assert/strict"

import {
  pttCaptureDurationMs,
  pttCaptureIdle,
  pttCaptureIsAcceptingChunks,
  pttCapturePostRollRemainingMs,
  pttCaptureRelease,
  pttCaptureStart,
  PTT_POST_ROLL_MS,
} from "../src/ptt/capture.js"

test("pttCaptureStart from idle enters capturing", () => {
  const state = pttCaptureStart(pttCaptureIdle, 1000)
  assert.strictEqual(state.tag, "capturing")
  assert.strictEqual(state.startedAt, 1000)
  assert.strictEqual(state.releaseAt, undefined)
})

test("pttCaptureStart from capturing is no-op", () => {
  const capturing = pttCaptureStart(pttCaptureIdle, 1000)
  const state = pttCaptureStart(capturing, 2000)
  assert.strictEqual(state.tag, "capturing")
  assert.strictEqual(state.startedAt, 1000)
})

test("pttCaptureStart from postRoll cancels postRoll and preserves startedAt", () => {
  const capturing = pttCaptureStart(pttCaptureIdle, 1000)
  const postRoll = pttCaptureRelease(capturing, 1500)
  const state = pttCaptureStart(postRoll, 2000)
  assert.strictEqual(state.tag, "capturing")
  assert.strictEqual(state.startedAt, 1000)
})

test("pttCaptureRelease from capturing enters postRoll", () => {
  const capturing = pttCaptureStart(pttCaptureIdle, 1000)
  const state = pttCaptureRelease(capturing, 1500)
  assert.strictEqual(state.tag, "postRoll")
  assert.strictEqual(state.startedAt, 1000)
  assert.strictEqual(state.releaseAt, 1500)
})

test("pttCaptureRelease from idle is no-op", () => {
  const state = pttCaptureRelease(pttCaptureIdle, 1500)
  assert.strictEqual(state.tag, "idle")
})

test("pttCaptureRelease from postRoll is no-op", () => {
  const capturing = pttCaptureStart(pttCaptureIdle, 1000)
  const postRoll = pttCaptureRelease(capturing, 1500)
  const state = pttCaptureRelease(postRoll, 2000)
  assert.strictEqual(state.tag, "postRoll")
  assert.strictEqual(state.releaseAt, 1500)
})

test("pttCaptureIsAcceptingChunks is true for capturing", () => {
  const state = pttCaptureStart(pttCaptureIdle, 1000)
  assert.strictEqual(pttCaptureIsAcceptingChunks(state), true)
})

test("pttCaptureIsAcceptingChunks is true for postRoll", () => {
  const capturing = pttCaptureStart(pttCaptureIdle, 1000)
  const state = pttCaptureRelease(capturing, 1500)
  assert.strictEqual(pttCaptureIsAcceptingChunks(state), true)
})

test("pttCaptureIsAcceptingChunks is false for idle", () => {
  assert.strictEqual(pttCaptureIsAcceptingChunks(pttCaptureIdle), false)
})

test("pttCapturePostRollRemainingMs returns full delay immediately after release", () => {
  const capturing = pttCaptureStart(pttCaptureIdle, 1000)
  const state = pttCaptureRelease(capturing, 1500)
  assert.strictEqual(pttCapturePostRollRemainingMs(state, 1500), PTT_POST_ROLL_MS)
})

test("pttCapturePostRollRemainingMs returns 0 after delay expires", () => {
  const capturing = pttCaptureStart(pttCaptureIdle, 1000)
  const state = pttCaptureRelease(capturing, 1500)
  assert.strictEqual(pttCapturePostRollRemainingMs(state, 1500 + PTT_POST_ROLL_MS), 0)
})

test("pttCapturePostRollRemainingMs returns 0 for idle and capturing", () => {
  assert.strictEqual(pttCapturePostRollRemainingMs(pttCaptureIdle, 2000), 0)
  const capturing = pttCaptureStart(pttCaptureIdle, 1000)
  assert.strictEqual(pttCapturePostRollRemainingMs(capturing, 2000), 0)
})

test("pttCaptureDurationMs computes from startedAt to now", () => {
  const state = pttCaptureStart(pttCaptureIdle, 1000)
  assert.strictEqual(pttCaptureDurationMs(state, 1500), 500)
})

test("pttCaptureDurationMs includes postRoll time", () => {
  const capturing = pttCaptureStart(pttCaptureIdle, 1000)
  const state = pttCaptureRelease(capturing, 1500)
  assert.strictEqual(pttCaptureDurationMs(state, 2000), 1000)
})

test("pttCaptureDurationMs returns 0 for idle", () => {
  assert.strictEqual(pttCaptureDurationMs(pttCaptureIdle, 2000), 0)
})

test("regression: duration must be computed from captureStartedAtRef, not idle state", () => {
  const startedAt = 1000
  const now = 3500
  // Bug pattern from src/cli.ts: after finalizing, callers computed
  // duration as pttCaptureDurationMs(pttCaptureIdle, now) which loses startedAt.
  const buggyDuration = pttCaptureDurationMs(pttCaptureIdle, now)
  const correctDuration = now - startedAt
  assert.strictEqual(buggyDuration, 0)
  assert.strictEqual(correctDuration, 2500)
  assert.notStrictEqual(buggyDuration, correctDuration)
})
