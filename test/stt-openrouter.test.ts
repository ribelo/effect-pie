import { test } from "node:test"
import * as assert from "node:assert/strict"
import { Effect, Exit } from "effect"

import {
  decodeStructuredTransciption,
  decodeStructuredTranslation,
  encodePcm16MonoWav,
} from "../src/stt/openrouter.js"

test("encodePcm16MonoWav writes a RIFF/WAVE payload", () => {
  const pcm = new Uint8Array([0x00, 0x00, 0xff, 0x7f])
  const wav = encodePcm16MonoWav(pcm, 16_000)

  assert.strictEqual(wav.length, 48)
  assert.strictEqual(String.fromCharCode(...wav.slice(0, 4)), "RIFF")
  assert.strictEqual(String.fromCharCode(...wav.slice(8, 12)), "WAVE")
  assert.strictEqual(String.fromCharCode(...wav.slice(36, 40)), "data")
})

test("decodeStructuredTransciption reads the transciption field", async () => {
  const decoded = await Effect.runPromise(decodeStructuredTransciption('{"transciption":"hello"}'))
  assert.strictEqual(decoded, "hello")
})

test("decodeStructuredTransciption accepts transcription alias", async () => {
  const decoded = await Effect.runPromise(decodeStructuredTransciption('{"transcription":"hello"}'))
  assert.strictEqual(decoded, "hello")
})

test("decodeStructuredTransciption fails when transcript field is missing", async () => {
  const exit = await Effect.runPromiseExit(decodeStructuredTransciption('{"text":"hello"}'))

  assert.strictEqual(Exit.isFailure(exit), true)
})

test("decodeStructuredTranslation reads translation field", async () => {
  const decoded = await Effect.runPromise(decodeStructuredTranslation('{"translation":"hello"}'))
  assert.strictEqual(decoded, "hello")
})

test("decodeStructuredTranslation accepts legacy transcription aliases", async () => {
  const decoded = await Effect.runPromise(decodeStructuredTranslation('{"transcription":"legacy"}'))
  assert.strictEqual(decoded, "legacy")
})
