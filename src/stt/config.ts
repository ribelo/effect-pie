import { Data, Effect, Schema } from "effect"
import * as fs from "node:fs/promises"
import * as path from "node:path"

import { EFFECT_PI_CONFIG_DIR } from "../paths.js"

export const STT_CONFIG_PATH = path.join(EFFECT_PI_CONFIG_DIR, "stt.json")

const resolvePromptsDir = (configPath: string): string =>
  path.join(path.dirname(configPath), "prompts")

const resolveTranscriptionPromptPath = (configPath: string): string =>
  path.join(resolvePromptsDir(configPath), "transcription.md")

const resolveTranslationPromptPath = (configPath: string): string =>
  path.join(resolvePromptsDir(configPath), "translation.md")

const DEFAULT_TRANSCRIPTION_PROMPT = `Transcribe the spoken audio in {{language}}.

Rules:
- Preserve the speaker's wording, intent, tone, and style, even when blunt, harsh, or informal.
- Preserve mixed Polish/English speech instead of normalizing it to one language.
- Keep commands, CLI flags, identifiers, API names, package names, filenames, paths, product names, and code tokens unchanged.
- Do not translate the audio.
- Use best effort to recover the intended wording when technical speech is unclear, but do not invent meaning that is not supported by the audio.
- Return only the transcription.
`

const DEFAULT_TRANSLATION_PROMPT = `Translate the spoken audio from {{source_language}} to {{target_language}}.

Rules:
- Preserve the speaker's intent, tone, and style, even when blunt, harsh, or informal.
- Handle mixed Polish/English technical speech naturally.
- Keep commands, CLI flags, identifiers, API names, package names, filenames, paths, product names, and code tokens unchanged.
- Keep English technical terms in English when translating them would sound unnatural or reduce clarity.
- If the audio contains a span that starts with \`dodatkowe instrukcje\` and ends with \`koniec instrukcji\`, treat that span as extra translation instructions for the rest of the utterance.
- Do not include the \`dodatkowe instrukcje ... koniec instrukcji\` span in the translated output.
- If those markers are unbalanced or ambiguous, ignore the control-span rule and translate the audio literally instead.
- Translate surrounding prose clearly and faithfully.
- Use best effort to resolve mixed-language phrasing from context, but do not invent meaning that is not supported by the audio.
- Return only the translation.
`

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

type LegacySttRuntimeConfig = {
  readonly schemaVersion: 1
  readonly openrouter: {
    readonly transcriptionModel: string
    readonly translationModel: string
    readonly defaultTargetLanguage: string
  }
}

type LanguageOnlySttRuntimeConfig = {
  readonly schemaVersion: 1
  readonly openrouter: {
    readonly transcriptionModel: string
    readonly translationModel: string
    readonly transcriptionLanguage: string
    readonly translationSourceLanguage: string
    readonly translationTargetLanguage: string
  }
}

export const defaultSttRuntimeConfig: SttRuntimeConfig = {
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
  transcriptionPrompt: DEFAULT_TRANSCRIPTION_PROMPT,
  translationPrompt: DEFAULT_TRANSLATION_PROMPT,
}

export class SttConfigError extends Data.TaggedError("SttConfigError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

const hasNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0

const hasPositiveFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0

const hasBoolean = (value: unknown): value is boolean => typeof value === "boolean"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

const isErrnoException = (cause: unknown): cause is NodeJS.ErrnoException =>
  isRecord(cause) && typeof cause["code"] === "string"

const isCurrentSttRuntimeConfig = (value: unknown): value is SttRuntimeConfig => {
  if (!isRecord(value)) {
    return false
  }

  const config = value
  const openrouter = config["openrouter"]

  if (config["schemaVersion"] !== 1 || !isRecord(openrouter)) {
    return false
  }

  const section = openrouter
  return (
    hasNonEmptyString(section["transcriptionModel"]) &&
    hasNonEmptyString(section["translationModel"]) &&
    hasNonEmptyString(section["transcriptionLanguage"]) &&
    hasNonEmptyString(section["translationSourceLanguage"]) &&
    hasNonEmptyString(section["translationTargetLanguage"]) &&
    hasBoolean(section["wakewordEnabled"]) &&
    hasPositiveFiniteNumber(section["wakewordDictationSilenceSeconds"]) &&
    hasPositiveFiniteNumber(section["wakewordDictationMaxSeconds"]) &&
    hasPositiveFiniteNumber(section["wakewordDictationSpeechRmsThreshold"])
  )
}

const hasCurrentSpecificFields = (section: Record<string, unknown>): boolean =>
  section["wakewordEnabled"] !== undefined ||
  section["wakewordDictationSilenceSeconds"] !== undefined ||
  section["wakewordDictationMaxSeconds"] !== undefined ||
  section["wakewordDictationSpeechRmsThreshold"] !== undefined

const isLanguageOnlySttRuntimeConfig = (value: unknown): value is LanguageOnlySttRuntimeConfig => {
  if (!isRecord(value)) {
    return false
  }

  const config = value
  const openrouter = config["openrouter"]

  if (config["schemaVersion"] !== 1 || !isRecord(openrouter)) {
    return false
  }

  const section = openrouter
  if (hasCurrentSpecificFields(section)) {
    return false
  }

  return (
    hasNonEmptyString(section["transcriptionModel"]) &&
    hasNonEmptyString(section["translationModel"]) &&
    hasNonEmptyString(section["transcriptionLanguage"]) &&
    hasNonEmptyString(section["translationSourceLanguage"]) &&
    hasNonEmptyString(section["translationTargetLanguage"])
  )
}

const isLegacySttRuntimeConfig = (value: unknown): value is LegacySttRuntimeConfig => {
  if (!isRecord(value)) {
    return false
  }

  const config = value
  const openrouter = config["openrouter"]

  if (config["schemaVersion"] !== 1 || !isRecord(openrouter)) {
    return false
  }

  const section = openrouter
  return (
    hasNonEmptyString(section["transcriptionModel"]) &&
    hasNonEmptyString(section["translationModel"]) &&
    hasNonEmptyString(section["defaultTargetLanguage"])
  )
}

const normalizeSttRuntimeConfig = (config: SttRuntimeConfig): SttRuntimeConfig => ({
  schemaVersion: 1,
  openrouter: {
    transcriptionModel: config.openrouter.transcriptionModel.trim(),
    translationModel: config.openrouter.translationModel.trim(),
    transcriptionLanguage: config.openrouter.transcriptionLanguage.trim(),
    translationSourceLanguage: config.openrouter.translationSourceLanguage.trim(),
    translationTargetLanguage: config.openrouter.translationTargetLanguage.trim(),
    wakewordEnabled: config.openrouter.wakewordEnabled,
    wakewordDictationSilenceSeconds: config.openrouter.wakewordDictationSilenceSeconds,
    wakewordDictationMaxSeconds: config.openrouter.wakewordDictationMaxSeconds,
    wakewordDictationSpeechRmsThreshold: config.openrouter.wakewordDictationSpeechRmsThreshold,
  },
  transcriptionPrompt: config.transcriptionPrompt?.trim() ?? DEFAULT_TRANSCRIPTION_PROMPT,
  translationPrompt: config.translationPrompt?.trim() ?? DEFAULT_TRANSLATION_PROMPT,
})

const migrateLegacyConfig = (legacy: LegacySttRuntimeConfig): SttRuntimeConfig =>
  normalizeSttRuntimeConfig({
    schemaVersion: 1,
    openrouter: {
      transcriptionModel: legacy.openrouter.transcriptionModel,
      translationModel: legacy.openrouter.translationModel,
      transcriptionLanguage: "English",
      translationSourceLanguage: "English",
      translationTargetLanguage: legacy.openrouter.defaultTargetLanguage,
      wakewordEnabled: true,
      wakewordDictationSilenceSeconds: 3,
      wakewordDictationMaxSeconds: 120,
      wakewordDictationSpeechRmsThreshold: 0.01,
    },
    transcriptionPrompt: DEFAULT_TRANSCRIPTION_PROMPT,
    translationPrompt: DEFAULT_TRANSLATION_PROMPT,
  })

const migrateLanguageOnlyConfig = (config: LanguageOnlySttRuntimeConfig): SttRuntimeConfig =>
  normalizeSttRuntimeConfig({
    schemaVersion: 1,
    openrouter: {
      transcriptionModel: config.openrouter.transcriptionModel,
      translationModel: config.openrouter.translationModel,
      transcriptionLanguage: config.openrouter.transcriptionLanguage,
      translationSourceLanguage: config.openrouter.translationSourceLanguage,
      translationTargetLanguage: config.openrouter.translationTargetLanguage,
      wakewordEnabled: true,
      wakewordDictationSilenceSeconds: 3,
      wakewordDictationMaxSeconds: 120,
      wakewordDictationSpeechRmsThreshold: 0.01,
    },
    transcriptionPrompt: DEFAULT_TRANSCRIPTION_PROMPT,
    translationPrompt: DEFAULT_TRANSLATION_PROMPT,
  })

const parseSttRuntimeConfig = (
  value: unknown,
): { readonly config: SttRuntimeConfig; readonly migrated: boolean } | undefined => {
  if (isCurrentSttRuntimeConfig(value)) {
    return {
      config: normalizeSttRuntimeConfig(value),
      migrated: false,
    }
  }

  if (isLanguageOnlySttRuntimeConfig(value)) {
    return {
      config: migrateLanguageOnlyConfig(value),
      migrated: true,
    }
  }

  if (isLegacySttRuntimeConfig(value)) {
    return {
      config: migrateLegacyConfig(value),
      migrated: true,
    }
  }

  return undefined
}

const writeConfigFile = (
  configPath: string,
  config: SttRuntimeConfig,
): Effect.Effect<void, SttConfigError> =>
  Effect.tryPromise({
    try: async () => {
      await fs.mkdir(path.dirname(configPath), { recursive: true })
      await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8")
    },
    catch: (cause) =>
      new SttConfigError({
        message: `Failed to write STT config at ${configPath}`,
        cause,
      }),
  })

const ensurePromptFile = (
  promptPath: string,
  defaultContent: string,
): Effect.Effect<void, SttConfigError> =>
  Effect.tryPromise({
    try: async () => {
      try {
        await fs.access(promptPath)
        return
      } catch {
        await fs.mkdir(path.dirname(promptPath), { recursive: true })
        await fs.writeFile(promptPath, defaultContent, "utf8")
      }
    },
    catch: (cause) =>
      new SttConfigError({
        message: `Failed to bootstrap prompt file at ${promptPath}`,
        cause,
      }),
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

export const loadSttRuntimeConfig = (
  configPath = STT_CONFIG_PATH,
): Effect.Effect<SttRuntimeConfig, SttConfigError> =>
  Effect.gen(function* () {
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

    let config: SttRuntimeConfig

    if (raw !== undefined) {
      const parsedJson = yield* Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(raw).pipe(
        Effect.mapError(
          (cause) =>
            new SttConfigError({
              message: `Failed to parse STT config JSON from ${configPath}`,
              cause,
            }),
        ),
      )

      const parsed = parseSttRuntimeConfig(parsedJson)
      if (parsed !== undefined) {
        if (parsed.migrated) {
          yield* writeConfigFile(configPath, parsed.config)
        }

        config = parsed.config
      } else {
        return yield* new SttConfigError({
          message: `Invalid STT config at ${configPath}: unrecognized config shape or invalid field values`,
        })
      }
    } else {
      config = normalizeSttRuntimeConfig(defaultSttRuntimeConfig)
      yield* writeConfigFile(configPath, config)
    }

    yield* ensurePromptFile(transcriptionPromptPath, DEFAULT_TRANSCRIPTION_PROMPT)
    yield* ensurePromptFile(translationPromptPath, DEFAULT_TRANSLATION_PROMPT)

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
