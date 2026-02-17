import * as Effect from "effect/Effect";
import { promises as fs } from "node:fs";
import * as path from "node:path";

import {
  OPENWAKEWORD_RUNTIME_PACKAGE,
  OPENWAKEWORD_RUNTIME_VERSION,
  type ResolvedWakewordAssets,
  type WakewordAssetManifest,
} from "./defs.js";

export class WakewordAssetError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, { cause: options?.cause });
    this.name = "WakewordAssetError";
  }
}

export type WakewordAssetOptions = {
  readonly rootDir?: string;
  readonly wakewordModels?: ReadonlyArray<string>;
  readonly validateRuntime?: boolean;
  readonly validateWakewordModels?: boolean;
  readonly validateFeatureModels?: boolean;
};

const defaultRootDir = path.join(process.cwd(), "assets", "openwakeword");

const ensureReadableFile = (filePath: string): Effect.Effect<void, WakewordAssetError> =>
  Effect.tryPromise({
    try: async () => {
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) {
        throw new Error("path is not a file");
      }
      if (stat.size === 0) {
        throw new Error("file is empty");
      }
    },
    catch: (cause) =>
      new WakewordAssetError(`Missing or invalid model asset: ${filePath}`, {
        cause,
      }),
  });

const FEATURE_PLACEHOLDER_MARKER = "effect-pi placeholder feature model file";
const MIN_FEATURE_MODEL_BYTES = 4_096;

const ensureRealFeatureOnnxFile = (
  filePath: string,
  label: "melspectrogram" | "embedding",
): Effect.Effect<void, WakewordAssetError> =>
  Effect.tryPromise({
    try: async () => {
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) {
        throw new Error("path is not a file");
      }

      if (stat.size < MIN_FEATURE_MODEL_BYTES) {
        throw new Error(
          `feature model is too small (${stat.size} bytes). Real ONNX model is required`,
        );
      }

      const raw = await fs.readFile(filePath);
      const preview = raw.subarray(0, 256).toString("utf8").toLowerCase();
      if (preview.includes(FEATURE_PLACEHOLDER_MARKER)) {
        throw new Error("feature model placeholder marker detected");
      }
    },
    catch: (cause) =>
      new WakewordAssetError(
        `Invalid ${label} feature model at ${filePath}. Install real openWakeWord ONNX feature models before training or detection.`,
        {
          cause,
        },
      ),
  });

const normalizeWakewordModelName = (entry: string): string => {
  const base = path.basename(entry);
  if (base.endsWith(".onnx")) {
    return base.slice(0, -".onnx".length);
  }
  if (base.endsWith(".json")) {
    return base.slice(0, -".json".length);
  }
  return base;
};

const toWakewordModelPath = (rootDir: string, entry: string): string => {
  const hasKnownExtension = entry.endsWith(".onnx") || entry.endsWith(".json");
  const fileName = hasKnownExtension ? entry : `${entry}.onnx`;
  return path.isAbsolute(fileName)
    ? fileName
    : path.join(rootDir, "wakewords", path.basename(fileName));
};

const readManifest = (
  manifestPath: string,
): Effect.Effect<WakewordAssetManifest, WakewordAssetError> =>
  Effect.tryPromise({
    try: async () => {
      const raw = await fs.readFile(manifestPath, "utf8");
      const parsed = JSON.parse(raw) as WakewordAssetManifest;

      if (parsed.schemaVersion !== 1) {
        throw new Error(
          `Unsupported wakeword manifest schema version: ${String(parsed.schemaVersion)}`,
        );
      }

      if (
        typeof parsed.runtime?.package !== "string" ||
        typeof parsed.runtime?.version !== "string" ||
        typeof parsed.models?.melspectrogram !== "string" ||
        typeof parsed.models?.embedding !== "string" ||
        !Array.isArray(parsed.models?.wakewords)
      ) {
        throw new Error("Wakeword manifest is missing required keys");
      }

      return parsed;
    },
    catch: (cause) =>
      new WakewordAssetError(`Failed to read wakeword manifest at ${manifestPath}`, {
        cause,
      }),
  });

const validateRuntimePin = (
  runtimePackage: string,
  runtimeVersion: string,
): Effect.Effect<void, WakewordAssetError> =>
  Effect.tryPromise({
    try: async () => {
      if (
        runtimePackage !== OPENWAKEWORD_RUNTIME_PACKAGE ||
        runtimeVersion !== OPENWAKEWORD_RUNTIME_VERSION
      ) {
        throw new Error(
          `Expected runtime ${OPENWAKEWORD_RUNTIME_PACKAGE}@${OPENWAKEWORD_RUNTIME_VERSION}, got ${runtimePackage}@${runtimeVersion}`,
        );
      }

      const packageJsonPath = path.join(
        process.cwd(),
        "node_modules",
        runtimePackage,
        "package.json",
      );
      const raw = await fs.readFile(packageJsonPath, "utf8");
      const pkg = JSON.parse(raw) as { readonly version?: string };

      if (pkg.version !== runtimeVersion) {
        throw new Error(
          `Installed ${runtimePackage} version ${pkg.version ?? "<unknown>"} does not match required ${runtimeVersion}`,
        );
      }
    },
    catch: (cause) =>
      new WakewordAssetError(
        `Wakeword runtime validation failed. Install ${runtimePackage}@${runtimeVersion} with bun before starting wakeword detection.`,
        {
          cause,
        },
      ),
  });

export const resolveWakewordAssets = (
  options: WakewordAssetOptions = {},
): Effect.Effect<ResolvedWakewordAssets, WakewordAssetError> =>
  Effect.gen(function* () {
    const rootDir = path.resolve(options.rootDir ?? defaultRootDir);
    const manifestPath = path.join(rootDir, "manifest.json");

    const manifest = yield* readManifest(manifestPath);

    const wakewordEntries =
      options.wakewordModels && options.wakewordModels.length > 0
        ? options.wakewordModels
        : manifest.models.wakewords;

    if ((options.validateWakewordModels ?? true) && wakewordEntries.length === 0) {
      return yield* Effect.fail(
        new WakewordAssetError("Wakeword manifest does not declare any wakeword model files"),
      );
    }

    const wakewordModelPairs = wakewordEntries.map(
      (entry) => [normalizeWakewordModelName(entry), toWakewordModelPath(rootDir, entry)] as const,
    );

    const resolved: ResolvedWakewordAssets = {
      rootDir,
      manifestPath,
      melspectrogramModelPath: path.join(rootDir, manifest.models.melspectrogram),
      embeddingModelPath: path.join(rootDir, manifest.models.embedding),
      wakewordModelPaths: Object.fromEntries(wakewordModelPairs),
      runtimePackage: manifest.runtime.package,
      runtimeVersion: manifest.runtime.version,
    };

    return resolved;
  });

export const validateWakewordAssets = (
  options: WakewordAssetOptions = {},
): Effect.Effect<ResolvedWakewordAssets, WakewordAssetError> =>
  Effect.gen(function* () {
    const resolved = yield* resolveWakewordAssets(options);

    yield* ensureReadableFile(resolved.melspectrogramModelPath);
    yield* ensureReadableFile(resolved.embeddingModelPath);

    if (options.validateFeatureModels ?? true) {
      yield* ensureRealFeatureOnnxFile(resolved.melspectrogramModelPath, "melspectrogram");
      yield* ensureRealFeatureOnnxFile(resolved.embeddingModelPath, "embedding");
    }

    if (options.validateWakewordModels ?? true) {
      for (const wakewordModelPath of Object.values(resolved.wakewordModelPaths)) {
        yield* ensureReadableFile(wakewordModelPath);
      }
    }

    if (options.validateRuntime ?? true) {
      yield* validateRuntimePin(resolved.runtimePackage, resolved.runtimeVersion);
    }

    return resolved;
  });
