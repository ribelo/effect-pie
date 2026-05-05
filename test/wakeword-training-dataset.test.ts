import { test } from "node:test"
import * as assert from "node:assert/strict"
import { Effect, Exit } from "effect"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import * as path from "node:path"

import {
  decodePcmWavFile,
  loadSavedWavClips,
  makeWakewordTrainingPlan,
  nextWavPath,
  sortedWavPaths,
  validateMinimumClips,
} from "../src/wakeword/training.js"

const writeValidWav = async (outputPath: string, pcmBytes: Uint8Array, sampleRate = 16_000) => {
  const header = new ArrayBuffer(44)
  const view = new DataView(header)

  const writeString = (offset: number, value: string): void => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index))
    }
  }

  writeString(0, "RIFF")
  view.setUint32(4, 36 + pcmBytes.length, true)
  writeString(8, "WAVE")
  writeString(12, "fmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeString(36, "data")
  view.setUint32(40, pcmBytes.length, true)

  const wavData = new Uint8Array(44 + pcmBytes.length)
  wavData.set(new Uint8Array(header), 0)
  wavData.set(pcmBytes, 44)

  await writeFile(outputPath, wavData)
}

test("makeWakewordTrainingPlan includes silenceDir", () => {
  const plan = makeWakewordTrainingPlan({ name: "test_model" })
  assert.ok(plan.silenceDir.includes("silence"))
})

test("sortedWavPaths returns WAV files sorted", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "pie-wakeword-"))
  await writeFile(path.join(tempDir, "z.wav"), Buffer.from(""), "utf8")
  await writeFile(path.join(tempDir, "a.wav"), Buffer.from(""), "utf8")
  await writeFile(path.join(tempDir, "m.txt"), Buffer.from(""), "utf8")

  const result = await Effect.runPromise(sortedWavPaths(tempDir))
  assert.strictEqual(result.length, 2)
  assert.ok(result[0]?.includes("a.wav"))
  assert.ok(result[1]?.includes("z.wav"))
})

test("nextWavPath returns first path when directory is empty", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "pie-wakeword-"))
  const next = await Effect.runPromise(nextWavPath(tempDir, "positive"))
  assert.strictEqual(path.basename(next), "positive-001.wav")
})

test("nextWavPath returns next available number", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "pie-wakeword-"))
  await writeFile(path.join(tempDir, "positive-001.wav"), Buffer.from(""), "utf8")
  await writeFile(path.join(tempDir, "positive-003.wav"), Buffer.from(""), "utf8")

  const next = await Effect.runPromise(nextWavPath(tempDir, "positive"))
  assert.strictEqual(path.basename(next), "positive-004.wav")
})

test("decodePcmWavFile extracts PCM from valid WAV", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "pie-wakeword-"))
  const pcm = new Uint8Array([0x00, 0x00, 0xff, 0x7f])
  const wavPath = path.join(tempDir, "test.wav")
  await writeValidWav(wavPath, pcm)

  const decoded = await Effect.runPromise(decodePcmWavFile(wavPath))
  assert.deepStrictEqual(decoded, pcm)
})

test("decodePcmWavFile rejects non-RIFF file", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "pie-wakeword-"))
  const wavPath = path.join(tempDir, "bad.wav")
  await writeFile(wavPath, "NOT A WAV FILE", "utf8")

  const exit = await Effect.runPromiseExit(decodePcmWavFile(wavPath))
  assert.strictEqual(Exit.isFailure(exit), true)
})

test("decodePcmWavFile rejects wrong sample rate", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "pie-wakeword-"))
  const pcm = new Uint8Array([0x00, 0x00])
  const wavPath = path.join(tempDir, "test.wav")
  await writeValidWav(wavPath, pcm, 44_100)

  const exit = await Effect.runPromiseExit(decodePcmWavFile(wavPath))
  assert.strictEqual(Exit.isFailure(exit), true)
})

test("decodePcmWavFile rejects truncated data", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "pie-wakeword-"))
  const pcm = new Uint8Array([0x00, 0x00, 0xff, 0x7f])
  const wavPath = path.join(tempDir, "test.wav")
  await writeValidWav(wavPath, pcm)

  const truncated = await import("node:fs/promises").then((fs) => fs.readFile(wavPath))
  await writeFile(wavPath, truncated.slice(0, 45))

  const exit = await Effect.runPromiseExit(decodePcmWavFile(wavPath))
  assert.strictEqual(Exit.isFailure(exit), true)
})

test("loadSavedWavClips loads all WAVs from directory", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "pie-wakeword-"))
  const pcm1 = new Uint8Array([0x01, 0x02])
  const pcm2 = new Uint8Array([0x03, 0x04])
  await writeValidWav(path.join(tempDir, "a.wav"), pcm1)
  await writeValidWav(path.join(tempDir, "b.wav"), pcm2)

  const clips = await Effect.runPromise(loadSavedWavClips(tempDir))
  assert.strictEqual(clips.length, 2)
  assert.deepStrictEqual(clips[0], pcm1)
  assert.deepStrictEqual(clips[1], pcm2)
})

test("validateMinimumClips passes when enough clips exist", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "pie-wakeword-"))
  await writeValidWav(path.join(tempDir, "a.wav"), new Uint8Array([0x01, 0x02]))
  await writeValidWav(path.join(tempDir, "b.wav"), new Uint8Array([0x03, 0x04]))

  const result = await Effect.runPromise(
    validateMinimumClips({ dir: tempDir, label: "positive", minimum: 2 }),
  )
  assert.strictEqual(result, undefined)
})

test("validateMinimumClips fails when not enough clips", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "pie-wakeword-"))
  await writeValidWav(path.join(tempDir, "a.wav"), new Uint8Array([0x01, 0x02]))

  const exit = await Effect.runPromiseExit(
    validateMinimumClips({ dir: tempDir, label: "positive", minimum: 5 }),
  )
  assert.strictEqual(Exit.isFailure(exit), true)
})

test("append behavior writes clips without overwriting", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "pie-wakeword-"))

  const pcm1 = new Uint8Array([0x01, 0x02])
  const path1 = await Effect.runPromise(nextWavPath(tempDir, "negative"))
  await writeValidWav(path1, pcm1)

  const pcm2 = new Uint8Array([0x03, 0x04])
  const path2 = await Effect.runPromise(nextWavPath(tempDir, "negative"))
  await writeValidWav(path2, pcm2)

  assert.strictEqual(path.basename(path1), "negative-001.wav")
  assert.strictEqual(path.basename(path2), "negative-002.wav")

  const loaded = await Effect.runPromise(loadSavedWavClips(tempDir))
  assert.strictEqual(loaded.length, 2)
  assert.deepStrictEqual(loaded[0], pcm1)
  assert.deepStrictEqual(loaded[1], pcm2)
})
