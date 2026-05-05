import { test } from "node:test"
import * as assert from "node:assert/strict"
import { Effect, Exit } from "effect"
import { mkdtemp, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import * as path from "node:path"

import { loadSttRuntimeConfig } from "../src/stt/config.js"

const writeValidConfig = async (configPath: string): Promise<void> => {
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        openrouter: {
          transcriptionModel: "mistralai/voxtral-small-24b-2507",
          translationModel: "google/gemini-3-flash-preview",
          transcriptionLanguage: "English",
          translationSourceLanguage: "English",
          translationTargetLanguage: "English",
          wakewordEnabled: true,
          wakewordDictationSilenceSeconds: 3,
          wakewordDictationMaxSeconds: 120,
          wakewordDictationSpeechRmsThreshold: 0.01,
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  )
}

const writeValidPrompts = async (configPath: string): Promise<void> => {
  const promptsDir = path.join(path.dirname(configPath), "prompts")
  await mkdir(promptsDir, { recursive: true })
  await writeFile(path.join(promptsDir, "transcription.md"), "Transcribe in {{language}}", "utf8")
  await writeFile(
    path.join(promptsDir, "translation.md"),
    "Translate {{source_language}} to {{target_language}}",
    "utf8",
  )
}

test("loadSttRuntimeConfig fails when config file is missing", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "pie-stt-"))
  const configPath = path.join(tempDir, "stt.json")

  const exit = await Effect.runPromiseExit(loadSttRuntimeConfig(configPath))
  assert.strictEqual(Exit.isFailure(exit), true)
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
          wakewordEnabled: false,
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
  await writeValidPrompts(configPath)

  const config = await Effect.runPromise(loadSttRuntimeConfig(configPath))

  assert.strictEqual(config.openrouter.transcriptionModel, "mistralai/voxtral-mini-3b-2507")
  assert.strictEqual(config.openrouter.translationModel, "google/gemini-2.5-flash")
  assert.strictEqual(config.openrouter.transcriptionLanguage, "Polish")
  assert.strictEqual(config.openrouter.translationSourceLanguage, "Polish")
  assert.strictEqual(config.openrouter.translationTargetLanguage, "English")
  assert.strictEqual(config.openrouter.wakewordEnabled, false)
  assert.strictEqual(config.openrouter.wakewordDictationSilenceSeconds, 2)
  assert.strictEqual(config.openrouter.wakewordDictationMaxSeconds, 60)
  assert.strictEqual(config.openrouter.wakewordDictationSpeechRmsThreshold, 0.02)
})

test("loadSttRuntimeConfig rejects language-only config without wakeword fields", async () => {
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
  await writeValidPrompts(configPath)

  const exit = await Effect.runPromiseExit(loadSttRuntimeConfig(configPath))
  assert.strictEqual(Exit.isFailure(exit), true)
})

test("loadSttRuntimeConfig rejects legacy defaultTargetLanguage config", async () => {
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
  await writeValidPrompts(configPath)

  const exit = await Effect.runPromiseExit(loadSttRuntimeConfig(configPath))
  assert.strictEqual(Exit.isFailure(exit), true)
})

test("loadSttRuntimeConfig preserves wakewordEnabled false", async () => {
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
          transcriptionLanguage: "English",
          translationSourceLanguage: "English",
          translationTargetLanguage: "English",
          wakewordEnabled: false,
          wakewordDictationSilenceSeconds: 3,
          wakewordDictationMaxSeconds: 120,
          wakewordDictationSpeechRmsThreshold: 0.01,
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  )
  await writeValidPrompts(configPath)

  const config = await Effect.runPromise(loadSttRuntimeConfig(configPath))
  assert.strictEqual(config.openrouter.wakewordEnabled, false)
})

test("loadSttRuntimeConfig rejects invalid wakewordEnabled", async () => {
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
          transcriptionLanguage: "English",
          translationSourceLanguage: "English",
          translationTargetLanguage: "English",
          wakewordEnabled: "yes",
          wakewordDictationSilenceSeconds: 3,
          wakewordDictationMaxSeconds: 120,
          wakewordDictationSpeechRmsThreshold: 0.01,
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  )
  await writeValidPrompts(configPath)

  const exit = await Effect.runPromiseExit(loadSttRuntimeConfig(configPath))
  assert.strictEqual(Exit.isFailure(exit), true)
})

test("loadSttRuntimeConfig fails when prompt files are missing", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "pie-stt-"))
  const configPath = path.join(tempDir, "stt.json")

  await writeValidConfig(configPath)

  const exit = await Effect.runPromiseExit(loadSttRuntimeConfig(configPath))
  assert.strictEqual(Exit.isFailure(exit), true)
})

test("loadSttRuntimeConfig preserves edited prompt files", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "pie-stt-"))
  const configPath = path.join(tempDir, "stt.json")
  const promptsDir = path.join(tempDir, "prompts")
  await mkdir(promptsDir, { recursive: true })

  await writeValidConfig(configPath)

  await writeFile(
    path.join(promptsDir, "transcription.md"),
    "Custom transcription {{language}}",
    "utf8",
  )
  await writeFile(
    path.join(promptsDir, "translation.md"),
    "Custom translation {{source_language}} to {{target_language}}",
    "utf8",
  )

  const config = await Effect.runPromise(loadSttRuntimeConfig(configPath))

  assert.strictEqual(config.transcriptionPrompt, "Custom transcription {{language}}")
  assert.strictEqual(
    config.translationPrompt,
    "Custom translation {{source_language}} to {{target_language}}",
  )
})

test("loadSttRuntimeConfig rejects empty transcription prompt", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "pie-stt-"))
  const configPath = path.join(tempDir, "stt.json")
  const promptsDir = path.join(tempDir, "prompts")
  await mkdir(promptsDir, { recursive: true })

  await writeValidConfig(configPath)

  await writeFile(path.join(promptsDir, "transcription.md"), "   ", "utf8")
  await writeFile(
    path.join(promptsDir, "translation.md"),
    "Valid {{source_language}} to {{target_language}}",
    "utf8",
  )

  const exit = await Effect.runPromiseExit(loadSttRuntimeConfig(configPath))

  assert.strictEqual(Exit.isFailure(exit), true)
})

test("loadSttRuntimeConfig rejects empty translation prompt", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "pie-stt-"))
  const configPath = path.join(tempDir, "stt.json")
  const promptsDir = path.join(tempDir, "prompts")
  await mkdir(promptsDir, { recursive: true })

  await writeValidConfig(configPath)

  await writeFile(path.join(promptsDir, "transcription.md"), "Valid {{language}}", "utf8")
  await writeFile(path.join(promptsDir, "translation.md"), "", "utf8")

  const exit = await Effect.runPromiseExit(loadSttRuntimeConfig(configPath))

  assert.strictEqual(Exit.isFailure(exit), true)
})

test("loadSttRuntimeConfig rejects transcription prompt missing placeholder", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "pie-stt-"))
  const configPath = path.join(tempDir, "stt.json")
  const promptsDir = path.join(tempDir, "prompts")
  await mkdir(promptsDir, { recursive: true })

  await writeValidConfig(configPath)

  await writeFile(path.join(promptsDir, "transcription.md"), "No placeholder here", "utf8")
  await writeFile(
    path.join(promptsDir, "translation.md"),
    "Valid {{source_language}} to {{target_language}}",
    "utf8",
  )

  const exit = await Effect.runPromiseExit(loadSttRuntimeConfig(configPath))

  assert.strictEqual(Exit.isFailure(exit), true)
})

test("loadSttRuntimeConfig rejects translation prompt missing source_language placeholder", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "pie-stt-"))
  const configPath = path.join(tempDir, "stt.json")
  const promptsDir = path.join(tempDir, "prompts")
  await mkdir(promptsDir, { recursive: true })

  await writeValidConfig(configPath)

  await writeFile(path.join(promptsDir, "transcription.md"), "Valid {{language}}", "utf8")
  await writeFile(
    path.join(promptsDir, "translation.md"),
    "Missing {{target_language}} only",
    "utf8",
  )

  const exit = await Effect.runPromiseExit(loadSttRuntimeConfig(configPath))

  assert.strictEqual(Exit.isFailure(exit), true)
})
