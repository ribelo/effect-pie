import { test } from "node:test"
import * as assert from "node:assert/strict"
import { Effect, Exit } from "effect"

import {
  decodeStructuredTranscription,
  decodeStructuredTranslation,
  encodePcm16MonoWav,
  patchServiceTier,
  patchSystemFingerprint,
  renderTemplate,
  TRANSCRIPTION_JSON_SCHEMA,
  TRANSLATION_JSON_SCHEMA,
} from "../src/stt/openrouter.js"

test("encodePcm16MonoWav writes a RIFF/WAVE payload", () => {
  const pcm = new Uint8Array([0x00, 0x00, 0xff, 0x7f])
  const wav = encodePcm16MonoWav(pcm, 16_000)

  assert.strictEqual(wav.length, 48)
  assert.strictEqual(String.fromCharCode(...wav.slice(0, 4)), "RIFF")
  assert.strictEqual(String.fromCharCode(...wav.slice(8, 12)), "WAVE")
  assert.strictEqual(String.fromCharCode(...wav.slice(36, 40)), "data")
})

test("decodeStructuredTranscription reads the transcription field", async () => {
  const decoded = await Effect.runPromise(
    decodeStructuredTranscription('{"transcription":"hello"}'),
  )
  assert.strictEqual(decoded, "hello")
})

test("decodeStructuredTranscription rejects legacy transciption alias", async () => {
  const exit = await Effect.runPromiseExit(
    decodeStructuredTranscription('{"transciption":"hello"}'),
  )
  assert.strictEqual(Exit.isFailure(exit), true)
})

test("decodeStructuredTranscription fails when transcription field is missing", async () => {
  const exit = await Effect.runPromiseExit(decodeStructuredTranscription('{"text":"hello"}'))

  assert.strictEqual(Exit.isFailure(exit), true)
})

test("decodeStructuredTranslation reads translation field", async () => {
  const decoded = await Effect.runPromise(decodeStructuredTranslation('{"translation":"hello"}'))
  assert.strictEqual(decoded, "hello")
})

test("decodeStructuredTranslation rejects legacy transcription aliases", async () => {
  const exit = await Effect.runPromiseExit(
    decodeStructuredTranslation('{"transcription":"legacy"}'),
  )
  assert.strictEqual(Exit.isFailure(exit), true)
})

test("renderTemplate substitutes {{language}} for transcription prompt", () => {
  const result = renderTemplate("Transcribe in {{language}}.", { language: "Polish" })
  assert.strictEqual(result, "Transcribe in Polish.")
})

test("renderTemplate substitutes {{source_language}} and {{target_language}} for translation prompt", () => {
  const result = renderTemplate("Translate from {{source_language}} to {{target_language}}.", {
    source_language: "Polish",
    target_language: "English",
  })
  assert.strictEqual(result, "Translate from Polish to English.")
})

test("renderTemplate leaves unknown placeholders empty", () => {
  const result = renderTemplate("Hello {{name}}.", {})
  assert.strictEqual(result, "Hello .")
})

test("TRANSCRIPTION_JSON_SCHEMA requires transcription string field", () => {
  assert.strictEqual(TRANSCRIPTION_JSON_SCHEMA.type, "object")
  assert.deepStrictEqual(TRANSCRIPTION_JSON_SCHEMA.required, ["transcription"])
  assert.strictEqual(TRANSCRIPTION_JSON_SCHEMA.additionalProperties, false)
  assert.strictEqual(TRANSCRIPTION_JSON_SCHEMA.properties.transcription.type, "string")
})

test("TRANSLATION_JSON_SCHEMA requires translation string field", () => {
  assert.strictEqual(TRANSLATION_JSON_SCHEMA.type, "object")
  assert.deepStrictEqual(TRANSLATION_JSON_SCHEMA.required, ["translation"])
  assert.strictEqual(TRANSLATION_JSON_SCHEMA.additionalProperties, false)
  assert.strictEqual(TRANSLATION_JSON_SCHEMA.properties.translation.type, "string")
})

test("decodeStructuredTranscription fails without raw fallback for malformed JSON", async () => {
  const exit = await Effect.runPromiseExit(decodeStructuredTranscription("not valid json"))
  assert.strictEqual(Exit.isFailure(exit), true)
})

test("decodeStructuredTranslation fails without raw fallback for missing field", async () => {
  const exit = await Effect.runPromiseExit(decodeStructuredTranslation('{"text":"hello"}'))
  assert.strictEqual(Exit.isFailure(exit), true)
})

test("patchSystemFingerprint replaces null with empty string", () => {
  const patched = patchSystemFingerprint({ system_fingerprint: null, choices: [] })
  assert.deepStrictEqual(patched, { system_fingerprint: "", choices: [] })
})

test("patchSystemFingerprint leaves string fingerprint untouched", () => {
  const patched = patchSystemFingerprint({ system_fingerprint: "fp_abc", choices: [] })
  assert.deepStrictEqual(patched, { system_fingerprint: "fp_abc", choices: [] })
})

test("patchSystemFingerprint leaves missing fingerprint untouched", () => {
  const patched = patchSystemFingerprint({ choices: [] })
  assert.deepStrictEqual(patched, { choices: [] })
})

test("patchSystemFingerprint leaves non-record untouched", () => {
  assert.strictEqual(patchSystemFingerprint("raw text"), "raw text")
  assert.strictEqual(patchSystemFingerprint(42), 42)
  assert.deepStrictEqual(patchSystemFingerprint(null), null)
})

test("patchServiceTier strips service_tier field", () => {
  const patched = patchServiceTier({ service_tier: "standard", choices: [] })
  assert.deepStrictEqual(patched, { choices: [] })
})

test("patchServiceTier leaves record without service_tier untouched", () => {
  const patched = patchServiceTier({ choices: [] })
  assert.deepStrictEqual(patched, { choices: [] })
})

test("patchServiceTier leaves non-record untouched", () => {
  assert.strictEqual(patchServiceTier("raw text"), "raw text")
  assert.strictEqual(patchServiceTier(42), 42)
  assert.deepStrictEqual(patchServiceTier(null), null)
})
