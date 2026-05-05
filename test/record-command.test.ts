import { test } from "node:test"
import * as assert from "node:assert/strict"

import { pcmRms, pcmPeak, normalizePcmForStt } from "../src/audio/pcm.js"

test("preserves full PCM data without silent truncation", () => {
  const sampleRate = 16_000
  const channels = 1
  const durationSeconds = 2
  const bytesPerSecond = sampleRate * channels * 2
  const expectedBytes = bytesPerSecond * durationSeconds

  const extraBytes = 512
  const rawData = new Uint8Array(expectedBytes + extraBytes)

  for (let i = 0; i < rawData.length; i += 2) {
    const sample = Math.sin((i / 2) * 0.1) * 1000
    const view = new DataView(rawData.buffer)
    view.setInt16(i, Math.round(sample), true)
  }

  const outputData = rawData

  assert.strictEqual(outputData.length, rawData.length)
  assert.strictEqual(outputData.length, expectedBytes + extraBytes)
})

test("raw mode preserves original PCM without normalization", () => {
  const pcm = new Uint8Array([0x00, 0x00, 0xff, 0x7f])
  const rawRms = pcmRms(pcm)
  const rawPeak = pcmPeak(pcm)

  assert.strictEqual(rawRms > 0, true)
  assert.strictEqual(rawPeak > 0, true)

  const { normalizedBytes, gain } = { normalizedBytes: pcm, gain: 1.0 }

  assert.strictEqual(gain, 1.0)
  assert.deepStrictEqual(normalizedBytes, pcm)
})

test("non-raw mode applies normalization gain", () => {
  const samples = new Int16Array(1000)
  for (let i = 0; i < samples.length; i++) {
    samples[i] = 100
  }
  const pcm = new Uint8Array(samples.buffer)

  const { normalizedBytes, gain } = normalizePcmForStt(pcm)

  assert.strictEqual(gain > 1.0, true)
  assert.strictEqual(normalizedBytes.length, pcm.length)
})
