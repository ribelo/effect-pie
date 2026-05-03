import { test } from "node:test"
import * as assert from "node:assert/strict"

import {
  pttDeadInputDetectorInitial,
  pttDeadInputDetectorProcessChunk,
  pttDeadInputDetectorSync,
  PTT_DEAD_INPUT_WARNING_ZERO_CHUNKS,
} from "../src/ptt/deadInput.js"

const zeroChunk = (): Uint8Array => new Uint8Array(1024)
const noisyChunk = (): Uint8Array => {
  const chunk = new Uint8Array(1024)
  chunk[0] = 1
  return chunk
}

test("pttDeadInputDetector warns after four zero chunks", () => {
  let detector = pttDeadInputDetectorSync(pttDeadInputDetectorInitial(), true)

  let result = pttDeadInputDetectorProcessChunk(detector, zeroChunk())
  assert.strictEqual(result.warn, false)
  detector = result.detector

  result = pttDeadInputDetectorProcessChunk(detector, zeroChunk())
  assert.strictEqual(result.warn, false)
  detector = result.detector

  result = pttDeadInputDetectorProcessChunk(detector, zeroChunk())
  assert.strictEqual(result.warn, false)
  detector = result.detector

  result = pttDeadInputDetectorProcessChunk(detector, zeroChunk())
  assert.strictEqual(result.warn, true)
  detector = result.detector

  result = pttDeadInputDetectorProcessChunk(detector, zeroChunk())
  assert.strictEqual(result.warn, false)
})

test("pttDeadInputDetector resets on non-zero chunk", () => {
  let detector = pttDeadInputDetectorSync(pttDeadInputDetectorInitial(), true)

  let result = pttDeadInputDetectorProcessChunk(detector, zeroChunk())
  assert.strictEqual(result.warn, false)
  detector = result.detector

  result = pttDeadInputDetectorProcessChunk(detector, zeroChunk())
  assert.strictEqual(result.warn, false)
  detector = result.detector

  result = pttDeadInputDetectorProcessChunk(detector, noisyChunk())
  assert.strictEqual(result.warn, false)
  detector = result.detector

  result = pttDeadInputDetectorProcessChunk(detector, zeroChunk())
  assert.strictEqual(result.warn, false)
  detector = result.detector

  result = pttDeadInputDetectorProcessChunk(detector, zeroChunk())
  assert.strictEqual(result.warn, false)
  detector = result.detector

  result = pttDeadInputDetectorProcessChunk(detector, zeroChunk())
  assert.strictEqual(result.warn, false)
  detector = result.detector

  result = pttDeadInputDetectorProcessChunk(detector, zeroChunk())
  assert.strictEqual(result.warn, true)
})

test("pttDeadInputDetector resets between holds", () => {
  let detector = pttDeadInputDetectorSync(pttDeadInputDetectorInitial(), true)

  for (let i = 0; i < PTT_DEAD_INPUT_WARNING_ZERO_CHUNKS; i += 1) {
    const result = pttDeadInputDetectorProcessChunk(detector, zeroChunk())
    detector = result.detector
  }

  assert.strictEqual(detector.warnedThisHold, true)

  detector = pttDeadInputDetectorSync(detector, false)
  detector = pttDeadInputDetectorSync(detector, true)

  let result = pttDeadInputDetectorProcessChunk(detector, zeroChunk())
  assert.strictEqual(result.warn, false)
  detector = result.detector

  result = pttDeadInputDetectorProcessChunk(detector, zeroChunk())
  assert.strictEqual(result.warn, false)
  detector = result.detector

  result = pttDeadInputDetectorProcessChunk(detector, zeroChunk())
  assert.strictEqual(result.warn, false)
  detector = result.detector

  result = pttDeadInputDetectorProcessChunk(detector, zeroChunk())
  assert.strictEqual(result.warn, true)
})

test("pttDeadInputDetector stays idle outside PTT", () => {
  let detector = pttDeadInputDetectorSync(pttDeadInputDetectorInitial(), false)
  const result = pttDeadInputDetectorProcessChunk(detector, zeroChunk())
  assert.strictEqual(result.warn, false)
})

test("pttDeadInputDetector ignores empty chunk", () => {
  let detector = pttDeadInputDetectorSync(pttDeadInputDetectorInitial(), true)
  const result = pttDeadInputDetectorProcessChunk(detector, new Uint8Array(0))
  assert.strictEqual(result.warn, false)
})
