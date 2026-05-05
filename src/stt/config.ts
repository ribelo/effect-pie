import { Data, Effect, Schema } from "effect"
import * as fs from "node:fs/promises"
import * as path from "node:path"

import { EFFECT_PI_CONFIG_DIR } from "../paths.js"
import { isRecord } from "../utils/isRecord.js"

export const STT_CONFIG_PATH = path.join(EFFECT_PI_CONFIG_DIR, "stt.json")

const resolvePromptsDir = (configPath: string): string =>
  path.join(path.dirname(configPath), "prompts")

const resolveTranscriptionPromptPath = (configPath: string): string =>
  path.join(resolvePromptsDir(configPath), "transcription.md")

const resolveTranslationPromptPath = (configPath: string): string =>
  path.join(resolvePromptsDir(configPath), "translation.md")

export type SttRuntimeConfig = {
  readonly schemaVersion: 1
  readonly openrouter: {
    readonly transcriptionModel: string
    readonly translationModel: string
    readonly transcriptionLanguage: string
    readonly translationSourceLanguage: string
    readonly translationTargetLanguage: string
    readonly wakewordEnabled: boolean
    readonly wakewordDictationSilenceSeconds: number
    readonly wakewordDictationMaxSeconds: number
    readonly wakewordDictationSpeechRmsThreshold: number
  }
  readonly transcriptionPrompt: string
  readonly translationPrompt: string
}

export class SttConfigError extends Data.TaggedError("SttConfigError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

const isErrnoException = (cause: unknown): cause is NodeJS.ErrnoException =>
  isRecord(cause) && typeof cause["code"] === "string"

const SttRuntimeConfigSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  openrouter: Schema.Struct({
    transcriptionModel: Schema.NonEmptyString,
    translationModel: Schema.NonEmptyString,
    transcriptionLanguage: Schema.NonEmptyString,
    translationSourceLanguage: Schema.NonEmptyString,
    translationTargetLanguage: Schema.NonEmptyString,
    wakewordEnabled: Schema.Boolean,
    wakewordDictationSilenceSeconds: Schema.Number.check(Schema.isGreaterThan(0)),
    wakewordDictationMaxSeconds: Schema.Number.check(Schema.isGreaterThan(0)),
    wakewordDictationSpeechRmsThreshold: Schema.Number.check(Schema.isGreaterThan(0)),
  }),
  transcriptionPrompt: Schema.optional(Schema.String),
  translationPrompt: Schema.optional(Schema.String),
})

const normalizeSttRuntimeConfig = (config: {
  readonly schemaVersion: 1
  readonly openrouter: SttRuntimeConfig["openrouter"]
  readonly transcriptionPrompt?: string | undefined
  readonly translationPrompt?: string | undefined
}): SttRuntimeConfig => ({
  schemaVersion: 1,
  openrouter: config.openrouter,
  transcriptionPrompt: config.transcriptionPrompt?.trim() ?? "",
  translationPrompt: config.translationPrompt?.trim() ?? "",
})

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
      message: `STT config file not found at ${configPath}. Create it with explicit configuration.`,
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

  const parsed = yield* Schema.decodeUnknownEffect(SttRuntimeConfigSchema)(parsedJson).pipe(
    Effect.mapError(
      (cause) =>
        new SttConfigError({
          message: `Unrecognized STT config at ${configPath}.`,
          cause,
        }),
    ),
  )

  const config = normalizeSttRuntimeConfig(parsed)

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
    ...config,
    transcriptionPrompt,
    translationPrompt,
  }
})
