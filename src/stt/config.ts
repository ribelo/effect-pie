import { Data, Effect, Schema } from "effect";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { EFFECT_PI_CONFIG_DIR } from "../paths.js";

export const STT_CONFIG_PATH = path.join(EFFECT_PI_CONFIG_DIR, "stt.json");

export type SttRuntimeConfig = {
  readonly schemaVersion: 1;
  readonly openrouter: {
    readonly transcriptionModel: string;
    readonly translationModel: string;
    readonly transcriptionLanguage: string;
    readonly translationSourceLanguage: string;
    readonly translationTargetLanguage: string;
    readonly wakewordDictationSilenceSeconds: number;
    readonly wakewordDictationMaxSeconds: number;
    readonly wakewordDictationSpeechRmsThreshold: number;
  };
};

type LegacySttRuntimeConfig = {
  readonly schemaVersion: 1;
  readonly openrouter: {
    readonly transcriptionModel: string;
    readonly translationModel: string;
    readonly defaultTargetLanguage: string;
  };
};

type LanguageOnlySttRuntimeConfig = {
  readonly schemaVersion: 1;
  readonly openrouter: {
    readonly transcriptionModel: string;
    readonly translationModel: string;
    readonly transcriptionLanguage: string;
    readonly translationSourceLanguage: string;
    readonly translationTargetLanguage: string;
  };
};

export const defaultSttRuntimeConfig: SttRuntimeConfig = {
  schemaVersion: 1,
  openrouter: {
    transcriptionModel: "mistralai/voxtral-small-24b-2507",
    translationModel: "google/gemini-3-flash-preview",
    transcriptionLanguage: "English",
    translationSourceLanguage: "English",
    translationTargetLanguage: "English",
    wakewordDictationSilenceSeconds: 3,
    wakewordDictationMaxSeconds: 45,
    wakewordDictationSpeechRmsThreshold: 0.01,
  },
};

export class SttConfigError extends Data.TaggedError("SttConfigError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const hasNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const hasPositiveFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

const isCurrentSttRuntimeConfig = (value: unknown): value is SttRuntimeConfig => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const config = value as Record<string, unknown>;
  const openrouter = config.openrouter;

  if (config.schemaVersion !== 1 || typeof openrouter !== "object" || openrouter === null) {
    return false;
  }

  const section = openrouter as Record<string, unknown>;
  return (
    hasNonEmptyString(section.transcriptionModel) &&
    hasNonEmptyString(section.translationModel) &&
    hasNonEmptyString(section.transcriptionLanguage) &&
    hasNonEmptyString(section.translationSourceLanguage) &&
    hasNonEmptyString(section.translationTargetLanguage) &&
    hasPositiveFiniteNumber(section.wakewordDictationSilenceSeconds) &&
    hasPositiveFiniteNumber(section.wakewordDictationMaxSeconds) &&
    hasPositiveFiniteNumber(section.wakewordDictationSpeechRmsThreshold)
  );
};

const isLanguageOnlySttRuntimeConfig = (value: unknown): value is LanguageOnlySttRuntimeConfig => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const config = value as Record<string, unknown>;
  const openrouter = config.openrouter;

  if (config.schemaVersion !== 1 || typeof openrouter !== "object" || openrouter === null) {
    return false;
  }

  const section = openrouter as Record<string, unknown>;
  return (
    hasNonEmptyString(section.transcriptionModel) &&
    hasNonEmptyString(section.translationModel) &&
    hasNonEmptyString(section.transcriptionLanguage) &&
    hasNonEmptyString(section.translationSourceLanguage) &&
    hasNonEmptyString(section.translationTargetLanguage)
  );
};

const isLegacySttRuntimeConfig = (value: unknown): value is LegacySttRuntimeConfig => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const config = value as Record<string, unknown>;
  const openrouter = config.openrouter;

  if (config.schemaVersion !== 1 || typeof openrouter !== "object" || openrouter === null) {
    return false;
  }

  const section = openrouter as Record<string, unknown>;
  return (
    hasNonEmptyString(section.transcriptionModel) &&
    hasNonEmptyString(section.translationModel) &&
    hasNonEmptyString(section.defaultTargetLanguage)
  );
};

const normalizeSttRuntimeConfig = (config: SttRuntimeConfig): SttRuntimeConfig => ({
  schemaVersion: 1,
  openrouter: {
    transcriptionModel: config.openrouter.transcriptionModel.trim(),
    translationModel: config.openrouter.translationModel.trim(),
    transcriptionLanguage: config.openrouter.transcriptionLanguage.trim(),
    translationSourceLanguage: config.openrouter.translationSourceLanguage.trim(),
    translationTargetLanguage: config.openrouter.translationTargetLanguage.trim(),
    wakewordDictationSilenceSeconds: config.openrouter.wakewordDictationSilenceSeconds,
    wakewordDictationMaxSeconds: config.openrouter.wakewordDictationMaxSeconds,
    wakewordDictationSpeechRmsThreshold: config.openrouter.wakewordDictationSpeechRmsThreshold,
  },
});

const migrateLegacyConfig = (legacy: LegacySttRuntimeConfig): SttRuntimeConfig =>
  normalizeSttRuntimeConfig({
    schemaVersion: 1,
    openrouter: {
      transcriptionModel: legacy.openrouter.transcriptionModel,
      translationModel: legacy.openrouter.translationModel,
      transcriptionLanguage: "English",
      translationSourceLanguage: "English",
      translationTargetLanguage: legacy.openrouter.defaultTargetLanguage,
      wakewordDictationSilenceSeconds: 3,
      wakewordDictationMaxSeconds: 45,
      wakewordDictationSpeechRmsThreshold: 0.01,
    },
  });

const migrateLanguageOnlyConfig = (config: LanguageOnlySttRuntimeConfig): SttRuntimeConfig =>
  normalizeSttRuntimeConfig({
    schemaVersion: 1,
    openrouter: {
      transcriptionModel: config.openrouter.transcriptionModel,
      translationModel: config.openrouter.translationModel,
      transcriptionLanguage: config.openrouter.transcriptionLanguage,
      translationSourceLanguage: config.openrouter.translationSourceLanguage,
      translationTargetLanguage: config.openrouter.translationTargetLanguage,
      wakewordDictationSilenceSeconds: 3,
      wakewordDictationMaxSeconds: 45,
      wakewordDictationSpeechRmsThreshold: 0.01,
    },
  });

const parseSttRuntimeConfig = (
  value: unknown,
): { readonly config: SttRuntimeConfig; readonly migrated: boolean } | undefined => {
  if (isCurrentSttRuntimeConfig(value)) {
    return {
      config: normalizeSttRuntimeConfig(value),
      migrated: false,
    };
  }

  if (isLanguageOnlySttRuntimeConfig(value)) {
    return {
      config: migrateLanguageOnlyConfig(value),
      migrated: true,
    };
  }

  if (isLegacySttRuntimeConfig(value)) {
    return {
      config: migrateLegacyConfig(value),
      migrated: true,
    };
  }

  return undefined;
};

const writeConfigFile = (
  configPath: string,
  config: SttRuntimeConfig,
): Effect.Effect<void, SttConfigError> =>
  Effect.tryPromise({
    try: async () => {
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    },
    catch: (cause) =>
      new SttConfigError({
        message: `Failed to write STT config at ${configPath}`,
        cause,
      }),
  });

export const loadSttRuntimeConfig = (
  configPath = STT_CONFIG_PATH,
): Effect.Effect<SttRuntimeConfig, SttConfigError> =>
  Effect.gen(function* () {
    const raw = yield* Effect.tryPromise({
      try: async (): Promise<string | undefined> => {
        try {
          return await fs.readFile(configPath, "utf8");
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
            return undefined;
          }

          throw cause;
        }
      },
      catch: (cause) =>
        new SttConfigError({
          message: `Failed to load STT config from ${configPath}`,
          cause,
        }),
    });

    if (raw !== undefined) {
      const parsedJson = yield* Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(raw).pipe(
        Effect.mapError(
          (cause) =>
            new SttConfigError({
              message: `Failed to parse STT config JSON from ${configPath}`,
              cause,
            }),
        ),
      );

      const parsed = parseSttRuntimeConfig(parsedJson);
      if (parsed !== undefined) {
        if (parsed.migrated) {
          yield* writeConfigFile(configPath, parsed.config);
        }

        return parsed.config;
      }
    }

    const defaults = normalizeSttRuntimeConfig(defaultSttRuntimeConfig);
    yield* writeConfigFile(configPath, defaults);
    return defaults;
  });
