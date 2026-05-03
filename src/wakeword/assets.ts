import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";

import { BUNDLED_OPENWAKEWORD_ASSET_DIR, EFFECT_PI_OPENWAKEWORD_DATA_DIR } from "../paths.js";
import {
  OPENWAKEWORD_RUNTIME_PACKAGE,
  OPENWAKEWORD_RUNTIME_VERSION,
  type ResolvedWakewordAssets,
  type WakewordAssetManifest,
} from "./defs.js";

export class WakewordAssetError extends Data.TaggedError("WakewordAssetError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export type WakewordAssetOptions = {
  readonly rootDir?: string;
  readonly wakewordModels?: ReadonlyArray<string>;
  readonly validateRuntime?: boolean;
  readonly validateWakewordModels?: boolean;
  readonly validateFeatureModels?: boolean;
};

const defaultRootDir = EFFECT_PI_OPENWAKEWORD_DATA_DIR;
const requireFromModule = createRequire(import.meta.url);

const ensureReadableFile = (filePath: string): Effect.Effect<void, WakewordAssetError> =>
  Effect.tryPromise({
    try: async () => {
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) {
        throw new WakewordAssetError({ message: "path is not a file" });
      }
      if (stat.size === 0) {
        throw new WakewordAssetError({ message: "file is empty" });
      }
    },
    catch: (cause) =>
      new WakewordAssetError({
        message: `Missing or invalid model asset: ${filePath}. Install required feature models with 'bun run wakeword:install-feature-models --melspectrogram-sha256 <sha256> --embedding-sha256 <sha256>'.`,
        cause,
      }),
  });

const FEATURE_PLACEHOLDER_MARKER = "pie placeholder feature model file";
const MIN_FEATURE_MODEL_BYTES = 4_096;

const ensureRealFeatureOnnxFile = (
  filePath: string,
  label: "melspectrogram" | "embedding",
): Effect.Effect<void, WakewordAssetError> =>
  Effect.tryPromise({
    try: async () => {
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) {
        throw new WakewordAssetError({ message: "path is not a file" });
      }

      if (stat.size < MIN_FEATURE_MODEL_BYTES) {
        throw new WakewordAssetError({
          message: `feature model is too small (${stat.size} bytes). Real ONNX model is required`,
        });
      }

      const raw = await fs.readFile(filePath);
      const preview = raw.subarray(0, 256).toString("utf8").toLowerCase();
      if (preview.includes(FEATURE_PLACEHOLDER_MARKER)) {
        throw new WakewordAssetError({
          message: "feature model placeholder marker detected",
        });
      }
    },
    catch: (cause) =>
      new WakewordAssetError({
        message: `Invalid ${label} feature model at ${filePath}. Install real openWakeWord ONNX feature models before training or detection.`,
        cause,
      }),
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
        throw new WakewordAssetError({
          message: `Unsupported wakeword manifest schema version: ${String(parsed.schemaVersion)}`,
        });
      }

      if (
        typeof parsed.runtime?.package !== "string" ||
        typeof parsed.runtime?.version !== "string" ||
        typeof parsed.models?.melspectrogram !== "string" ||
        typeof parsed.models?.embedding !== "string" ||
        !Array.isArray(parsed.models?.wakewords)
      ) {
        throw new WakewordAssetError({
          message: "Wakeword manifest is missing required keys",
        });
      }

      return parsed;
    },
    catch: (cause) =>
      new WakewordAssetError({
        message: `Failed to read wakeword manifest at ${manifestPath}`,
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
        throw new WakewordAssetError({
          message: `Expected runtime ${OPENWAKEWORD_RUNTIME_PACKAGE}@${OPENWAKEWORD_RUNTIME_VERSION}, got ${runtimePackage}@${runtimeVersion}`,
        });
      }

      const entryPath = requireFromModule.resolve(runtimePackage);
      const marker = `node_modules/${runtimePackage}/`;
      const idx = entryPath.lastIndexOf(marker);
      const packageJsonPath = idx >= 0
        ? path.join(entryPath.slice(0, idx + marker.length), "package.json")
        : requireFromModule.resolve(`${runtimePackage}/package.json`);
      const raw = await fs.readFile(packageJsonPath, "utf8");
      const pkg = JSON.parse(raw) as { readonly version?: string };

      if (pkg.version !== runtimeVersion) {
        throw new WakewordAssetError({
          message: `Installed ${runtimePackage} version ${pkg.version ?? "<unknown>"} does not match required ${runtimeVersion}`,
        });
      }
    },
    catch: (cause) =>
      new WakewordAssetError({
        message: `Wakeword runtime validation failed. Install ${runtimePackage}@${runtimeVersion} with npm before starting wakeword detection.`,
        cause,
      }),
  });

const copyFileIfExists = async (sourcePath: string, targetPath: string): Promise<void> => {
  try {
    const stat = await fs.stat(sourcePath);
    if (!stat.isFile()) {
      return;
    }
  } catch {
    return;
  }

  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.copyFile(sourcePath, targetPath);
};

const ensureDefaultAssetRoot = (targetRootDir: string): Effect.Effect<void, WakewordAssetError> =>
  Effect.tryPromise({
    try: async () => {
      const targetManifestPath = path.join(targetRootDir, "manifest.json");
      const sourceManifestPath = path.join(BUNDLED_OPENWAKEWORD_ASSET_DIR, "manifest.json");

      const targetManifestExists = await fs
        .access(targetManifestPath)
        .then(() => true)
        .catch(() => false);

      if (targetManifestExists) {
        return;
      }

      const sourceManifestExists = await fs
        .access(sourceManifestPath)
        .then(() => true)
        .catch(() => false);

      if (!sourceManifestExists) {
        return;
      }

      await fs.mkdir(targetRootDir, { recursive: true });
      await fs.copyFile(sourceManifestPath, targetManifestPath);

      await copyFileIfExists(
        path.join(BUNDLED_OPENWAKEWORD_ASSET_DIR, "melspectrogram.onnx"),
        path.join(targetRootDir, "melspectrogram.onnx"),
      );
      await copyFileIfExists(
        path.join(BUNDLED_OPENWAKEWORD_ASSET_DIR, "embedding_model.onnx"),
        path.join(targetRootDir, "embedding_model.onnx"),
      );

      const sourceWakewordsDir = path.join(BUNDLED_OPENWAKEWORD_ASSET_DIR, "wakewords");
      const targetWakewordsDir = path.join(targetRootDir, "wakewords");
      await fs.mkdir(targetWakewordsDir, { recursive: true });

      const sourceEntries = await fs
        .readdir(sourceWakewordsDir)
        .catch(() => [] as ReadonlyArray<string>);

      for (const entry of sourceEntries) {
        const sourcePath = path.join(sourceWakewordsDir, entry);
        const targetPath = path.join(targetWakewordsDir, entry);

        await copyFileIfExists(sourcePath, targetPath);
      }
    },
    catch: (cause) =>
      new WakewordAssetError({
        message: `Failed to initialize default wakeword data directory at ${targetRootDir}`,
        cause,
      }),
  });

export const resolveWakewordAssets = (
  options: WakewordAssetOptions = {},
): Effect.Effect<ResolvedWakewordAssets, WakewordAssetError> =>
  Effect.gen(function* () {
    const usingDefaultRoot = options.rootDir === undefined;
    const rootDir = path.resolve(options.rootDir ?? defaultRootDir);
    const manifestPath = path.join(rootDir, "manifest.json");

    if (usingDefaultRoot) {
      yield* ensureDefaultAssetRoot(rootDir);
    }

    const manifest = yield* readManifest(manifestPath);

    const wakewordEntries =
      options.wakewordModels && options.wakewordModels.length > 0
        ? options.wakewordModels
        : manifest.models.wakewords;

    if ((options.validateWakewordModels ?? true) && wakewordEntries.length === 0) {
      return yield* new WakewordAssetError({
        message: "Wakeword manifest does not declare any wakeword model files",
      });
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
