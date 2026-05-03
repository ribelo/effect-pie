import { test } from "node:test"
import * as assert from "node:assert/strict"
import { Effect } from "effect"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import * as path from "node:path"

import { loadSttRuntimeConfig } from "../src/stt/config.js"

test("loadSttRuntimeConfig creates defaults when file is missing", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "pie-stt-"))
  const configPath = path.join(tempDir, "stt.json")

  const config = await Effect.runPromise(loadSttRuntimeConfig(configPath))

  assert.strictEqual(config.openrouter.transcriptionModel, "mistralai/voxtral-small-24b-2507")
  assert.strictEqual(config.openrouter.translationModel, "google/gemini-3-flash-preview")
  assert.strictEqual(config.openrouter.transcriptionLanguage, "English")
  assert.strictEqual(config.openrouter.translationSourceLanguage, "English")
  assert.strictEqual(config.openrouter.translationTargetLanguage, "English")
  assert.strictEqual(config.openrouter.wakewordDictationSilenceSeconds, 3)
  assert.strictEqual(config.openrouter.wakewordDictationMaxSeconds, 45)
  assert.strictEqual(config.openrouter.wakewordDictationSpeechRmsThreshold, 0.01)

  const raw = await readFile(configPath, "utf8")
  assert.ok(raw.includes("mistralai/voxtral-small-24b-2507"))
  assert.ok(raw.includes("google/gemini-3-flash-preview"))
})

test("loadSttRuntimeConfig loads custom model and language configuration", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "pie-stt-"))
  const configPath = path.join(tempDir, "stt.json")

  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        openrouter: {
          transcriptionModel: "mistralai/voxtral-mini-3b-2507",
          translationModel: "google/gemini-2.5-flash",
          transcriptionLanguage: "Polish",
          translationSourceLanguage: "Polish",
          translationTargetLanguage: "English",
          wakewordDictationSilenceSeconds: 2,
          wakewordDictationMaxSeconds: 60,
          wakewordDictationSpeechRmsThreshold: 0.02,
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  )

  const config = await Effect.runPromise(loadSttRuntimeConfig(configPath))

  assert.strictEqual(config.openrouter.transcriptionModel, "mistralai/voxtral-mini-3b-2507")
  assert.strictEqual(config.openrouter.translationModel, "google/gemini-2.5-flash")
  assert.strictEqual(config.openrouter.transcriptionLanguage, "Polish")
  assert.strictEqual(config.openrouter.translationSourceLanguage, "Polish")
  assert.strictEqual(config.openrouter.translationTargetLanguage, "English")
  assert.strictEqual(config.openrouter.wakewordDictationSilenceSeconds, 2)
  assert.strictEqual(config.openrouter.wakewordDictationMaxSeconds, 60)
  assert.strictEqual(config.openrouter.wakewordDictationSpeechRmsThreshold, 0.02)
})

test("loadSttRuntimeConfig migrates language-only config with dictation defaults", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "pie-stt-"))
  const configPath = path.join(tempDir, "stt.json")

  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        openrouter: {
          transcriptionModel: "mistralai/voxtral-small-24b-2507",
          translationModel: "google/gemini-3-flash-preview",
          transcriptionLanguage: "Polish",
          translationSourceLanguage: "Polish",
          translationTargetLanguage: "English",
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  )

  const config = await Effect.runPromise(loadSttRuntimeConfig(configPath))

  assert.strictEqual(config.openrouter.transcriptionLanguage, "Polish")
  assert.strictEqual(config.openrouter.translationSourceLanguage, "Polish")
  assert.strictEqual(config.openrouter.translationTargetLanguage, "English")
  assert.strictEqual(config.openrouter.wakewordDictationSilenceSeconds, 3)
  assert.strictEqual(config.openrouter.wakewordDictationMaxSeconds, 45)
  assert.strictEqual(config.openrouter.wakewordDictationSpeechRmsThreshold, 0.01)
})

test("loadSttRuntimeConfig migrates legacy defaultTargetLanguage config", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "pie-stt-"))
  const configPath = path.join(tempDir, "stt.json")

  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        openrouter: {
          transcriptionModel: "mistralai/voxtral-small-24b-2507",
          translationModel: "google/gemini-3-flash-preview",
          defaultTargetLanguage: "Polish",
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  )

  const config = await Effect.runPromise(loadSttRuntimeConfig(configPath))

  assert.strictEqual(config.openrouter.transcriptionLanguage, "English")
  assert.strictEqual(config.openrouter.translationSourceLanguage, "English")
  assert.strictEqual(config.openrouter.translationTargetLanguage, "Polish")
  assert.strictEqual(config.openrouter.wakewordDictationSilenceSeconds, 3)
  assert.strictEqual(config.openrouter.wakewordDictationMaxSeconds, 45)
  assert.strictEqual(config.openrouter.wakewordDictationSpeechRmsThreshold, 0.01)

  const migratedRaw = await readFile(configPath, "utf8")
  assert.ok(migratedRaw.includes("translationTargetLanguage"))
  assert.ok(!migratedRaw.includes("defaultTargetLanguage"))
})
