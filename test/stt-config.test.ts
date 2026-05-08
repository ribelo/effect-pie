import { test } from "node:test"
import * as assert from "node:assert/strict"
import { Effect, Exit } from "effect"
import { mkdtemp, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import * as path from "node:path"

import { loadSttRuntimeConfig } from "../src/stt/config.js"

const writeValidCodexConfig = async (configPath: string): Promise<void> => {
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        schemaVersion: 2,
        provider: "codex-realtime",
        transcriptionModel: "gpt-realtime-whisper",
        translationModel: "gpt-realtime-translate",
        transcriptionLanguage: "English",
        translationSourceLanguage: "English",
        translationTargetLanguage: "en",
        wakewordEnabled: true,
        wakewordDictationSilenceSeconds: 3,
        wakewordDictationMaxSeconds: 120,
        wakewordDictationSpeechRmsThreshold: 0.01,
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

test("loadSttRuntimeConfig loads Codex realtime config with gpt-realtime-* models", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "pie-stt-"))
  const configPath = path.join(tempDir, "stt.json")

  await writeValidCodexConfig(configPath)
  await writeValidPrompts(configPath)

  const config = await Effect.runPromise(loadSttRuntimeConfig(configPath))

  assert.strictEqual(config.schemaVersion, 2)
  assert.strictEqual(config.provider, "codex-realtime")
  assert.strictEqual(config.transcriptionModel, "gpt-realtime-whisper")
  assert.strictEqual(config.translationModel, "gpt-realtime-translate")
  assert.strictEqual(config.transcriptionLanguage, "English")
  assert.strictEqual(config.translationSourceLanguage, "English")
  assert.strictEqual(config.translationTargetLanguage, "en")
  assert.strictEqual(config.wakewordEnabled, true)
  assert.strictEqual(config.wakewordDictationSilenceSeconds, 3)
  assert.strictEqual(config.wakewordDictationMaxSeconds, 120)
  assert.strictEqual(config.wakewordDictationSpeechRmsThreshold, 0.01)
})

test("loadSttRuntimeConfig preserves provider=openrouter for future use", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "pie-stt-"))
  const configPath = path.join(tempDir, "stt.json")
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        schemaVersion: 2,
        provider: "openrouter",
        transcriptionModel: "mistralai/voxtral-small-24b-2507",
        translationModel: "google/gemini-2.5-flash",
        transcriptionLanguage: "Polish",
        translationSourceLanguage: "Polish",
        translationTargetLanguage: "English",
        wakewordEnabled: false,
        wakewordDictationSilenceSeconds: 2,
        wakewordDictationMaxSeconds: 60,
        wakewordDictationSpeechRmsThreshold: 0.02,
      },
      null,
      2,
    )}\n`,
    "utf8",
  )
  await writeValidPrompts(configPath)

  const config = await Effect.runPromise(loadSttRuntimeConfig(configPath))
  assert.strictEqual(config.provider, "openrouter")
  assert.strictEqual(config.transcriptionModel, "mistralai/voxtral-small-24b-2507")
  assert.strictEqual(config.translationModel, "google/gemini-2.5-flash")
  assert.strictEqual(config.wakewordEnabled, false)
})

test("loadSttRuntimeConfig rejects Codex realtime translation target display names", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "pie-stt-"))
  const configPath = path.join(tempDir, "stt.json")

  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        schemaVersion: 2,
        provider: "codex-realtime",
        transcriptionModel: "gpt-realtime-whisper",
        translationModel: "gpt-realtime-translate",
        transcriptionLanguage: "Polish",
        translationSourceLanguage: "Polish",
        translationTargetLanguage: "English",
        wakewordEnabled: false,
        wakewordDictationSilenceSeconds: 3,
        wakewordDictationMaxSeconds: 120,
        wakewordDictationSpeechRmsThreshold: 0.01,
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

test("loadSttRuntimeConfig allows display-name targets for Codex conversation translation", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "pie-stt-"))
  const configPath = path.join(tempDir, "stt.json")

  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        schemaVersion: 2,
        provider: "codex-realtime",
        transcriptionModel: "gpt-realtime-whisper",
        translationModel: "gpt-realtime-2",
        transcriptionLanguage: "Polish",
        translationSourceLanguage: "Polish",
        translationTargetLanguage: "English",
        wakewordEnabled: false,
        wakewordDictationSilenceSeconds: 3,
        wakewordDictationMaxSeconds: 120,
        wakewordDictationSpeechRmsThreshold: 0.01,
      },
      null,
      2,
    )}\n`,
    "utf8",
  )
  await writeValidPrompts(configPath)

  const config = await Effect.runPromise(loadSttRuntimeConfig(configPath))
  assert.strictEqual(config.translationModel, "gpt-realtime-2")
  assert.strictEqual(config.translationTargetLanguage, "English")
})

test("loadSttRuntimeConfig rejects schemaVersion 1 nested openrouter block", async () => {
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
  await writeValidPrompts(configPath)

  const exit = await Effect.runPromiseExit(loadSttRuntimeConfig(configPath))
  assert.strictEqual(Exit.isFailure(exit), true)
})

test("loadSttRuntimeConfig rejects config missing provider field", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "pie-stt-"))
  const configPath = path.join(tempDir, "stt.json")

  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        schemaVersion: 2,
        transcriptionModel: "gpt-realtime-whisper",
        translationModel: "gpt-realtime-translate",
        transcriptionLanguage: "English",
        translationSourceLanguage: "English",
        translationTargetLanguage: "en",
        wakewordEnabled: true,
        wakewordDictationSilenceSeconds: 3,
        wakewordDictationMaxSeconds: 120,
        wakewordDictationSpeechRmsThreshold: 0.01,
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

test("loadSttRuntimeConfig rejects unknown provider value", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "pie-stt-"))
  const configPath = path.join(tempDir, "stt.json")

  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        schemaVersion: 2,
        provider: "anthropic",
        transcriptionModel: "x",
        translationModel: "x",
        transcriptionLanguage: "English",
        translationSourceLanguage: "English",
        translationTargetLanguage: "English",
        wakewordEnabled: true,
        wakewordDictationSilenceSeconds: 3,
        wakewordDictationMaxSeconds: 120,
        wakewordDictationSpeechRmsThreshold: 0.01,
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
        schemaVersion: 2,
        provider: "codex-realtime",
        defaultTargetLanguage: "Polish",
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
        schemaVersion: 2,
        provider: "codex-realtime",
        transcriptionModel: "gpt-realtime-whisper",
        translationModel: "gpt-realtime-translate",
        transcriptionLanguage: "English",
        translationSourceLanguage: "English",
        translationTargetLanguage: "en",
        wakewordEnabled: false,
        wakewordDictationSilenceSeconds: 3,
        wakewordDictationMaxSeconds: 120,
        wakewordDictationSpeechRmsThreshold: 0.01,
      },
      null,
      2,
    )}\n`,
    "utf8",
  )
  await writeValidPrompts(configPath)

  const config = await Effect.runPromise(loadSttRuntimeConfig(configPath))
  assert.strictEqual(config.wakewordEnabled, false)
})

test("loadSttRuntimeConfig rejects invalid wakewordEnabled", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "pie-stt-"))
  const configPath = path.join(tempDir, "stt.json")

  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        schemaVersion: 2,
        provider: "codex-realtime",
        transcriptionModel: "gpt-realtime-whisper",
        translationModel: "gpt-realtime-translate",
        transcriptionLanguage: "English",
        translationSourceLanguage: "English",
        translationTargetLanguage: "en",
        wakewordEnabled: "yes",
        wakewordDictationSilenceSeconds: 3,
        wakewordDictationMaxSeconds: 120,
        wakewordDictationSpeechRmsThreshold: 0.01,
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
  await writeValidCodexConfig(configPath)

  const exit = await Effect.runPromiseExit(loadSttRuntimeConfig(configPath))
  assert.strictEqual(Exit.isFailure(exit), true)
})

test("loadSttRuntimeConfig preserves edited prompt files", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "pie-stt-"))
  const configPath = path.join(tempDir, "stt.json")
  const promptsDir = path.join(tempDir, "prompts")
  await mkdir(promptsDir, { recursive: true })

  await writeValidCodexConfig(configPath)

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

  await writeValidCodexConfig(configPath)

  await writeFile(path.join(promptsDir, "transcription.md"), "   ", "utf8")
  await writeFile(
    path.join(promptsDir, "translation.md"),
    "Valid {{source_language}} to {{target_language}}",
    "utf8",
  )

  const exit = await Effect.runPromiseExit(loadSttRuntimeConfig(configPath))
  assert.strictEqual(Exit.isFailure(exit), true)
})

test("loadSttRuntimeConfig rejects translation prompt missing placeholders", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "pie-stt-"))
  const configPath = path.join(tempDir, "stt.json")
  const promptsDir = path.join(tempDir, "prompts")
  await mkdir(promptsDir, { recursive: true })

  await writeValidCodexConfig(configPath)

  await writeFile(path.join(promptsDir, "transcription.md"), "Valid {{language}}", "utf8")
  await writeFile(
    path.join(promptsDir, "translation.md"),
    "Missing {{target_language}} only",
    "utf8",
  )

  const exit = await Effect.runPromiseExit(loadSttRuntimeConfig(configPath))
  assert.strictEqual(Exit.isFailure(exit), true)
})
