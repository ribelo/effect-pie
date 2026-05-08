import { Data, Effect, Schema } from "effect"
import * as fs from "node:fs/promises"
import * as path from "node:path"

import { EFFECT_PI_CONFIG_DIR } from "../paths.js"
import { isRecord } from "../utils/isRecord.js"
import { DEFAULT_CODEX_TRANSLATION_MODEL } from "./codexRealtime.js"

export const STT_CONFIG_PATH = path.join(EFFECT_PI_CONFIG_DIR, "stt.json")

const resolvePromptsDir = (configPath: string): string =>
  path.join(path.dirname(configPath), "prompts")

const resolveTranscriptionPromptPath = (configPath: string): string =>
  path.join(resolvePromptsDir(configPath), "transcription.md")

const resolveTranslationPromptPath = (configPath: string): string =>
  path.join(resolvePromptsDir(configPath), "translation.md")

export type SttProvider = "codex-realtime" | "openrouter"

export type SttRuntimeConfig = {
  readonly schemaVersion: 2
  readonly provider: SttProvider
  readonly transcriptionModel: string
  readonly translationModel: string
  readonly transcriptionLanguage: string
  readonly translationSourceLanguage: string
  readonly translationTargetLanguage: string
  readonly wakewordEnabled: boolean
  readonly wakewordDictationSilenceSeconds: number
  readonly wakewordDictationMaxSeconds: number
  readonly wakewordDictationSpeechRmsThreshold: number
  readonly transcriptionPrompt: string
  readonly translationPrompt: string
}

export class SttConfigError extends Data.TaggedError("SttConfigError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

const isErrnoException = (cause: unknown): cause is NodeJS.ErrnoException =>
  isRecord(cause) && typeof cause["code"] === "string"

const SttProviderSchema = Schema.Literals(["codex-realtime", "openrouter"])

const SttRuntimeConfigSchema = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  provider: SttProviderSchema,
  transcriptionModel: Schema.NonEmptyString,
  translationModel: Schema.NonEmptyString,
  transcriptionLanguage: Schema.NonEmptyString,
  translationSourceLanguage: Schema.NonEmptyString,
  translationTargetLanguage: Schema.NonEmptyString,
  wakewordEnabled: Schema.Boolean,
  wakewordDictationSilenceSeconds: Schema.Number.check(Schema.isGreaterThan(0)),
  wakewordDictationMaxSeconds: Schema.Number.check(Schema.isGreaterThan(0)),
  wakewordDictationSpeechRmsThreshold: Schema.Number.check(Schema.isGreaterThan(0)),
  transcriptionPrompt: Schema.optional(Schema.String),
  translationPrompt: Schema.optional(Schema.String),
})

const CODEX_REALTIME_TRANSLATION_TARGET_LANGUAGES = new Set([
  "af",
  "ar",
  "az",
  "be",
  "bg",
  "bs",
  "ca",
  "cs",
  "cy",
  "da",
  "de",
  "el",
  "en",
  "es",
  "et",
  "fa",
  "fi",
  "fr",
  "gl",
  "he",
  "hi",
  "hr",
  "hu",
  "hy",
  "id",
  "is",
  "it",
  "iw",
  "ja",
  "kk",
  "kn",
  "ko",
  "lt",
  "lv",
  "mi",
  "mk",
  "mr",
  "ms",
  "ne",
  "nl",
  "no",
  "pl",
  "pt",
  "ro",
  "ru",
  "sk",
  "sl",
  "sr",
  "sv",
  "sw",
  "ta",
  "th",
  "tl",
  "tr",
  "uk",
  "ur",
  "vi",
  "zh",
])

const validateProviderConfig = (
  config: Schema.Schema.Type<typeof SttRuntimeConfigSchema>,
): string | undefined => {
  if (
    config.provider === "codex-realtime" &&
    config.translationModel === DEFAULT_CODEX_TRANSLATION_MODEL &&
    !CODEX_REALTIME_TRANSLATION_TARGET_LANGUAGES.has(config.translationTargetLanguage)
  ) {
    return `Codex realtime translationTargetLanguage must be a supported language code such as "en" or "pl"; got ${JSON.stringify(config.translationTargetLanguage)}`
  }

  return undefined
}

const readPromptFile = (promptPath: string): Effect.Effect<string, SttConfigError> =>
  Effect.tryPromise({
    try: async () => {
      const content = await fs.readFile(promptPath, "utf8")
      return content
    },
    catch: (cause) =>
      new SttConfigError({
        message: `Failed to read prompt file at ${promptPath}`,
        cause,
      }),
  })

const validateTranscriptionPrompt = (content: string): string | undefined => {
  const trimmed = content.trim()
  if (trimmed.length === 0) {
    return "transcription prompt is empty"
  }
  if (!trimmed.includes("{{language}}")) {
    return "transcription prompt missing required placeholder {{language}}"
  }
  return undefined
}

const validateTranslationPrompt = (content: string): string | undefined => {
  const trimmed = content.trim()
  if (trimmed.length === 0) {
    return "translation prompt is empty"
  }
  if (!trimmed.includes("{{source_language}}")) {
    return "translation prompt missing required placeholder {{source_language}}"
  }
  if (!trimmed.includes("{{target_language}}")) {
    return "translation prompt missing required placeholder {{target_language}}"
  }
  return undefined
}

export const loadSttRuntimeConfig = Effect.fn("pie/stt/config.loadSttRuntimeConfig")(function* (
  configPath: string = STT_CONFIG_PATH,
): Effect.fn.Return<SttRuntimeConfig, SttConfigError> {
  const transcriptionPromptPath = resolveTranscriptionPromptPath(configPath)
  const translationPromptPath = resolveTranslationPromptPath(configPath)

  const raw = yield* Effect.tryPromise({
    try: async (): Promise<string | undefined> => {
      try {
        return await fs.readFile(configPath, "utf8")
      } catch (cause) {
        if (isErrnoException(cause) && cause.code === "ENOENT") {
          return undefined
        }

        throw cause
      }
    },
    catch: (cause) =>
      new SttConfigError({
        message: `Failed to load STT config from ${configPath}`,
        cause,
      }),
  })

  if (raw === undefined) {
    return yield* new SttConfigError({
      message: `STT config file not found at ${configPath}. Create it with explicit configuration (schemaVersion: 2, provider, transcriptionModel, translationModel, transcription/translation language fields, wakeword fields).`,
    })
  }

  const parsedJson = yield* Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(raw).pipe(
    Effect.mapError(
      (cause) =>
        new SttConfigError({
          message: `Failed to parse STT config JSON from ${configPath}`,
          cause,
        }),
    ),
  )

  if (isRecord(parsedJson) && parsedJson["schemaVersion"] === 1) {
    return yield* new SttConfigError({
      message: `STT config at ${configPath} uses schemaVersion 1 (nested openrouter block). Delete the file or rewrite it as schemaVersion 2 with a top-level provider + flattened fields; effect-pie no longer migrates v1 configs.`,
    })
  }

  const parsed = yield* Schema.decodeUnknownEffect(SttRuntimeConfigSchema)(parsedJson).pipe(
    Effect.mapError(
      (cause) =>
        new SttConfigError({
          message: `Unrecognized STT config at ${configPath}. Expected schemaVersion 2 with fields: provider, transcriptionModel, translationModel, transcriptionLanguage, translationSourceLanguage, translationTargetLanguage, wakewordEnabled, wakewordDictationSilenceSeconds, wakewordDictationMaxSeconds, wakewordDictationSpeechRmsThreshold.`,
          cause,
        }),
    ),
  )

  const providerConfigError = validateProviderConfig(parsed)
  if (providerConfigError !== undefined) {
    return yield* new SttConfigError({
      message: `Invalid STT config at ${configPath}: ${providerConfigError}`,
    })
  }

  const transcriptionPrompt = yield* readPromptFile(transcriptionPromptPath)
  const translationPrompt = yield* readPromptFile(translationPromptPath)

  const transcriptionError = validateTranscriptionPrompt(transcriptionPrompt)
  if (transcriptionError !== undefined) {
    return yield* new SttConfigError({
      message: `Invalid transcription prompt at ${transcriptionPromptPath}: ${transcriptionError}`,
    })
  }

  const translationError = validateTranslationPrompt(translationPrompt)
  if (translationError !== undefined) {
    return yield* new SttConfigError({
      message: `Invalid translation prompt at ${translationPromptPath}: ${translationError}`,
    })
  }

  return {
    schemaVersion: 2,
    provider: parsed.provider,
    transcriptionModel: parsed.transcriptionModel,
    translationModel: parsed.translationModel,
    transcriptionLanguage: parsed.transcriptionLanguage,
    translationSourceLanguage: parsed.translationSourceLanguage,
    translationTargetLanguage: parsed.translationTargetLanguage,
    wakewordEnabled: parsed.wakewordEnabled,
    wakewordDictationSilenceSeconds: parsed.wakewordDictationSilenceSeconds,
    wakewordDictationMaxSeconds: parsed.wakewordDictationMaxSeconds,
    wakewordDictationSpeechRmsThreshold: parsed.wakewordDictationSpeechRmsThreshold,
    transcriptionPrompt,
    translationPrompt,
  }
})
