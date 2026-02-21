import { expect, test } from "bun:test";
import { Effect } from "effect";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { loadSttRuntimeConfig } from "../src/stt/config.js";

test("loadSttRuntimeConfig creates defaults when file is missing", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "effect-pi-stt-"));
  const configPath = path.join(tempDir, "stt.json");

  const config = await Effect.runPromise(loadSttRuntimeConfig(configPath));

  expect(config.openrouter.transcriptionModel).toBe("mistralai/voxtral-small-24b-2507");
  expect(config.openrouter.translationModel).toBe("google/gemini-3-flash-preview");
  expect(config.openrouter.transcriptionLanguage).toBe("English");
  expect(config.openrouter.translationSourceLanguage).toBe("English");
  expect(config.openrouter.translationTargetLanguage).toBe("English");
  expect(config.openrouter.wakewordDictationSilenceSeconds).toBe(3);
  expect(config.openrouter.wakewordDictationMaxSeconds).toBe(45);
  expect(config.openrouter.wakewordDictationSpeechRmsThreshold).toBe(0.01);

  const raw = await readFile(configPath, "utf8");
  expect(raw).toContain("mistralai/voxtral-small-24b-2507");
  expect(raw).toContain("google/gemini-3-flash-preview");
});

test("loadSttRuntimeConfig loads custom model and language configuration", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "effect-pi-stt-"));
  const configPath = path.join(tempDir, "stt.json");

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
  );

  const config = await Effect.runPromise(loadSttRuntimeConfig(configPath));

  expect(config.openrouter.transcriptionModel).toBe("mistralai/voxtral-mini-3b-2507");
  expect(config.openrouter.translationModel).toBe("google/gemini-2.5-flash");
  expect(config.openrouter.transcriptionLanguage).toBe("Polish");
  expect(config.openrouter.translationSourceLanguage).toBe("Polish");
  expect(config.openrouter.translationTargetLanguage).toBe("English");
  expect(config.openrouter.wakewordDictationSilenceSeconds).toBe(2);
  expect(config.openrouter.wakewordDictationMaxSeconds).toBe(60);
  expect(config.openrouter.wakewordDictationSpeechRmsThreshold).toBe(0.02);
});

test("loadSttRuntimeConfig migrates language-only config with dictation defaults", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "effect-pi-stt-"));
  const configPath = path.join(tempDir, "stt.json");

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
  );

  const config = await Effect.runPromise(loadSttRuntimeConfig(configPath));

  expect(config.openrouter.transcriptionLanguage).toBe("Polish");
  expect(config.openrouter.translationSourceLanguage).toBe("Polish");
  expect(config.openrouter.translationTargetLanguage).toBe("English");
  expect(config.openrouter.wakewordDictationSilenceSeconds).toBe(3);
  expect(config.openrouter.wakewordDictationMaxSeconds).toBe(45);
  expect(config.openrouter.wakewordDictationSpeechRmsThreshold).toBe(0.01);
});

test("loadSttRuntimeConfig migrates legacy defaultTargetLanguage config", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "effect-pi-stt-"));
  const configPath = path.join(tempDir, "stt.json");

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
  );

  const config = await Effect.runPromise(loadSttRuntimeConfig(configPath));

  expect(config.openrouter.transcriptionLanguage).toBe("English");
  expect(config.openrouter.translationSourceLanguage).toBe("English");
  expect(config.openrouter.translationTargetLanguage).toBe("Polish");
  expect(config.openrouter.wakewordDictationSilenceSeconds).toBe(3);
  expect(config.openrouter.wakewordDictationMaxSeconds).toBe(45);
  expect(config.openrouter.wakewordDictationSpeechRmsThreshold).toBe(0.01);

  const migratedRaw = await readFile(configPath, "utf8");
  expect(migratedRaw).toContain("translationTargetLanguage");
  expect(migratedRaw).not.toContain("defaultTargetLanguage");
});
