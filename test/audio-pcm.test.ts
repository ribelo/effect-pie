import { test } from "node:test"
import * as assert from "node:assert/strict"

import {
  computeNormalizationGain,
  DEFAULT_AUTO_GAIN_MAX,
  DEFAULT_AUTO_GAIN_PEAK_LIMIT,
  DEFAULT_AUTO_GAIN_TARGET_RMS,
  MIN_GAIN_TO_APPLY,
  normalizePcmS16leTargetRms,
  pcmPeak,
  pcmRms,
} from "../src/audio/pcm.js"

const sinePcmS16le = (
  sampleRate: number,
  hz: number,
  amplitude: number,
  durationSeconds: number,
): Uint8Array => {
  const sampleCount = Math.floor(sampleRate * durationSeconds)
  const bytes = new Uint8Array(sampleCount * 2)
  const view = new DataView(bytes.buffer)

  for (let i = 0; i < sampleCount; i += 1) {
    const t = i / sampleRate
    const sample = Math.sin(2 * Math.PI * hz * t) * amplitude
    const encoded = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)))
    view.setInt16(i * 2, encoded, true)
  }

  return bytes
}

test("pcmRms returns 0 for empty buffer", () => {
  assert.strictEqual(pcmRms(new Uint8Array(0)), 0)
})

test("pcmRms returns 0 for silence", () => {
  const silence = new Uint8Array(1024)
  assert.strictEqual(pcmRms(silence), 0)
})

test("pcmRms returns high value for loud signal", () => {
  const loud = new Uint8Array(1024)
  const view = new DataView(loud.buffer)
  for (let i = 0; i < 512; i += 1) {
    view.setInt16(i * 2, 32767, true)
  }
  const rms = pcmRms(loud)
  assert.ok(rms > 0.99, `expected rms > 0.99, got ${rms}`)
})

test("pcmRms ignores odd trailing byte", () => {
  const pcm = new Uint8Array(5)
  assert.strictEqual(pcmRms(pcm), 0)
})

test("pcmPeak returns 0 for empty buffer", () => {
  assert.strictEqual(pcmPeak(new Uint8Array(0)), 0)
})

test("pcmPeak returns max absolute normalized sample", () => {
  const pcm = new Uint8Array(4)
  const view = new DataView(pcm.buffer)
  view.setInt16(0, 16384, true) // 0.5
  view.setInt16(2, -32768, true) // -1.0
  assert.strictEqual(pcmPeak(pcm), 1.0)
})

test("computeNormalizationGain returns 1.0 for silence", () => {
  const gain = computeNormalizationGain({
    pcmBytes: new Uint8Array(1024),
    targetRms: DEFAULT_AUTO_GAIN_TARGET_RMS,
    maxGain: DEFAULT_AUTO_GAIN_MAX,
    peakLimit: DEFAULT_AUTO_GAIN_PEAK_LIMIT,
    silenceRmsThreshold: 0.003,
    silencePeakThreshold: 0.02,
  })
  assert.strictEqual(gain, 1.0)
})

test("computeNormalizationGain returns 1.0 for near-silence", () => {
  const quiet = sinePcmS16le(16000, 440, 0.0005, 0.5)
  const gain = computeNormalizationGain({
    pcmBytes: quiet,
    targetRms: DEFAULT_AUTO_GAIN_TARGET_RMS,
    maxGain: DEFAULT_AUTO_GAIN_MAX,
    peakLimit: DEFAULT_AUTO_GAIN_PEAK_LIMIT,
    silenceRmsThreshold: 0.003,
    silencePeakThreshold: 0.02,
  })
  assert.strictEqual(gain, 1.0)
})

test("computeNormalizationGain boosts quiet speech", () => {
  const quiet = sinePcmS16le(16000, 440, 0.01, 0.5)
  const gain = computeNormalizationGain({
    pcmBytes: quiet,
    targetRms: DEFAULT_AUTO_GAIN_TARGET_RMS,
    maxGain: DEFAULT_AUTO_GAIN_MAX,
    peakLimit: DEFAULT_AUTO_GAIN_PEAK_LIMIT,
    silenceRmsThreshold: 0.003,
    silencePeakThreshold: 0.02,
  })
  assert.ok(gain > 10.0, `expected significant gain, got ${gain}`)
})

test("computeNormalizationGain respects maxGain", () => {
  const veryQuiet = sinePcmS16le(16000, 440, 0.001, 0.5)
  const gain = computeNormalizationGain({
    pcmBytes: veryQuiet,
    targetRms: DEFAULT_AUTO_GAIN_TARGET_RMS,
    maxGain: 5.0,
    peakLimit: DEFAULT_AUTO_GAIN_PEAK_LIMIT,
    silenceRmsThreshold: 0.0001,
    silencePeakThreshold: 0.0001,
  })
  assert.ok(gain <= 5.0, `expected gain <= 5.0, got ${gain}`)
})

test("computeNormalizationGain respects peakLimit", () => {
  const loud = sinePcmS16le(16000, 440, 0.8, 0.5)
  const gain = computeNormalizationGain({
    pcmBytes: loud,
    targetRms: DEFAULT_AUTO_GAIN_TARGET_RMS,
    maxGain: DEFAULT_AUTO_GAIN_MAX,
    peakLimit: 0.95,
    silenceRmsThreshold: 0.003,
    silencePeakThreshold: 0.02,
  })
  const peak = pcmPeak(loud)
  assert.ok(
    gain * peak <= 0.95 + 0.001,
    `expected peak after gain <= 0.95, gain=${gain}, peak=${peak}`,
  )
})

test("normalizePcmS16leTargetRms boosts quiet clip to target without clipping", () => {
  const quiet = sinePcmS16le(16000, 440, 0.01, 0.5)
  const { normalizedBytes, gain } = normalizePcmS16leTargetRms({
    pcmBytes: quiet,
    targetRms: DEFAULT_AUTO_GAIN_TARGET_RMS,
    maxGain: DEFAULT_AUTO_GAIN_MAX,
    peakLimit: DEFAULT_AUTO_GAIN_PEAK_LIMIT,
    silenceRmsThreshold: 0.003,
    silencePeakThreshold: 0.02,
  })

  assert.ok(gain > 10.0, `expected significant gain, got ${gain}`)
  const rms = pcmRms(normalizedBytes)
  const peak = pcmPeak(normalizedBytes)
  assert.ok(Math.abs(rms - DEFAULT_AUTO_GAIN_TARGET_RMS) < 0.02, `rms=${rms}`)
  assert.ok(peak <= DEFAULT_AUTO_GAIN_PEAK_LIMIT + 0.001, `peak=${peak}`)
})

test("normalizePcmS16leTargetRms skips near-silent clip", () => {
  const quiet = sinePcmS16le(16000, 440, 0.0005, 0.5)
  const { normalizedBytes, gain } = normalizePcmS16leTargetRms({
    pcmBytes: quiet,
    targetRms: DEFAULT_AUTO_GAIN_TARGET_RMS,
    maxGain: DEFAULT_AUTO_GAIN_MAX,
    peakLimit: DEFAULT_AUTO_GAIN_PEAK_LIMIT,
    silenceRmsThreshold: 0.003,
    silencePeakThreshold: 0.02,
  })

  assert.strictEqual(gain, 1.0)
  assert.strictEqual(normalizedBytes, quiet)
})

test("normalizePcmS16leTargetRms does not mutate input", () => {
  const quiet = sinePcmS16le(16000, 440, 0.01, 0.5)
  const before = new Uint8Array(quiet)
  normalizePcmS16leTargetRms({
    pcmBytes: quiet,
    targetRms: DEFAULT_AUTO_GAIN_TARGET_RMS,
    maxGain: DEFAULT_AUTO_GAIN_MAX,
    peakLimit: DEFAULT_AUTO_GAIN_PEAK_LIMIT,
    silenceRmsThreshold: 0.003,
    silencePeakThreshold: 0.02,
  })
  assert.deepStrictEqual(quiet, before)
})

test("normalizePcmS16leTargetRms handles empty buffer", () => {
  const { normalizedBytes, gain } = normalizePcmS16leTargetRms({
    pcmBytes: new Uint8Array(0),
    targetRms: DEFAULT_AUTO_GAIN_TARGET_RMS,
    maxGain: DEFAULT_AUTO_GAIN_MAX,
    peakLimit: DEFAULT_AUTO_GAIN_PEAK_LIMIT,
    silenceRmsThreshold: 0.003,
    silencePeakThreshold: 0.02,
  })
  assert.strictEqual(gain, 1.0)
  assert.strictEqual(normalizedBytes.length, 0)
})

test("normalizePcmS16leTargetRms handles odd trailing byte", () => {
  const pcm = new Uint8Array(5)
  pcm[4] = 0xab
  const { normalizedBytes, gain } = normalizePcmS16leTargetRms({
    pcmBytes: pcm,
    targetRms: DEFAULT_AUTO_GAIN_TARGET_RMS,
    maxGain: DEFAULT_AUTO_GAIN_MAX,
    peakLimit: DEFAULT_AUTO_GAIN_PEAK_LIMIT,
    silenceRmsThreshold: 0.003,
    silencePeakThreshold: 0.02,
  })
  assert.strictEqual(gain, 1.0)
  assert.strictEqual(normalizedBytes.length, 5)
  assert.strictEqual(normalizedBytes[4], 0xab)
})
