import * as Effect from "effect/Effect";
import { promises as fs } from "node:fs";

import { type ResolvedWakewordAssets } from "./defs.js";

export class WakewordRuntimeError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, { cause: options?.cause });
    this.name = "WakewordRuntimeError";
  }
}

export type OnnxTensorData = {
  readonly data: Float32Array;
  readonly dims: ReadonlyArray<number>;
};

export type OnnxSession = {
  readonly inputName: string;
  readonly inputDims: ReadonlyArray<number | string | null | undefined>;
  readonly run: (input: OnnxTensorData) => Effect.Effect<OnnxTensorData, WakewordRuntimeError>;
};

export type WakewordScoringModel = {
  readonly requiredFrames: number;
  readonly expectedFeatureSize?: number;
  readonly score: (
    featureWindow: ReadonlyArray<Float32Array>,
  ) => Effect.Effect<number, WakewordRuntimeError>;
};

export type WakewordFeatureSessions = {
  readonly melspectrogram: OnnxSession;
  readonly embedding: OnnxSession;
};

export type WakewordModelSessions = WakewordFeatureSessions & {
  readonly wakewords: Readonly<Record<string, WakewordScoringModel>>;
};

type OrtModule = {
  readonly InferenceSession: {
    create: (modelPath: string, options?: Record<string, unknown>) => Promise<unknown>;
  };
  readonly Tensor: new (type: string, data: Float32Array, dims: ReadonlyArray<number>) => unknown;
};

type OrtSession = {
  readonly inputNames?: ReadonlyArray<string>;
  readonly outputNames?: ReadonlyArray<string>;
  readonly inputMetadata?: Record<string, { readonly dimensions?: ReadonlyArray<number | string> }>;
  readonly run: (feeds: Record<string, unknown>) => Promise<Record<string, unknown>>;
};

type OrtTensor = {
  readonly data?: Float32Array | ReadonlyArray<number>;
  readonly dims?: ReadonlyArray<number>;
};

type LinearWakewordModelFile = {
  readonly schemaVersion: 1;
  readonly type: "linear_wakeword";
  readonly frameCount: number;
  readonly featureSize: number;
  readonly weights: ReadonlyArray<number>;
  readonly bias: number;
  readonly logitScale?: number;
};

const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));

const toFloat32Array = (value: Float32Array | ReadonlyArray<number>): Float32Array =>
  value instanceof Float32Array ? value : Float32Array.from(value);

const flattenMatrix = (rows: ReadonlyArray<Float32Array>): Float32Array => {
  if (rows.length === 0) {
    return new Float32Array();
  }

  const width = rows[0]?.length ?? 0;
  const out = new Float32Array(rows.length * width);

  let offset = 0;
  for (const row of rows) {
    out.set(row, offset);
    offset += row.length;
  }

  return out;
};

const readOutputTensor = (outputs: Record<string, unknown>, outputName: string): OrtTensor => {
  const output = (outputs[outputName] ?? Object.values(outputs)[0]) as OrtTensor | undefined;
  if (!output?.data) {
    throw new Error(`Model did not produce tensor output '${outputName}'`);
  }
  return output;
};

const loadOrtModule = (runtimePackage: string): Effect.Effect<OrtModule, WakewordRuntimeError> =>
  Effect.tryPromise({
    try: () => import(runtimePackage) as Promise<OrtModule>,
    catch: (cause) =>
      new WakewordRuntimeError(
        `Unable to load ONNX runtime package '${runtimePackage}'. Run bun install and ensure runtime assets are pinned.`,
        {
          cause,
        },
      ),
  });

const makeSession = (
  ort: OrtModule,
  modelPath: string,
): Effect.Effect<OnnxSession, WakewordRuntimeError> =>
  Effect.tryPromise({
    try: async () => {
      const session = (await ort.InferenceSession.create(modelPath, {
        executionProviders: ["wasm"],
      })) as OrtSession;

      const inputName = session.inputNames?.[0];
      const outputName = session.outputNames?.[0];

      if (!inputName || !outputName) {
        throw new Error(`Could not inspect ONNX model IO metadata for ${modelPath}`);
      }

      const inputDims = session.inputMetadata?.[inputName]?.dimensions ?? [];

      return {
        inputName,
        inputDims,
        run: (input) =>
          Effect.tryPromise({
            try: async () => {
              const tensor = new ort.Tensor("float32", input.data, input.dims);
              const outputs = await session.run({ [inputName]: tensor });
              const output = readOutputTensor(outputs, outputName);
              const outputData = output.data;
              if (!outputData) {
                throw new Error(`Model output '${outputName}' is missing tensor data`);
              }

              const data = toFloat32Array(outputData);

              return {
                data,
                dims: output.dims ?? [data.length],
              };
            },
            catch: (cause) =>
              new WakewordRuntimeError(`ONNX inference failed for model ${modelPath}`, {
                cause,
              }),
          }),
      } satisfies OnnxSession;
    },
    catch: (cause) =>
      new WakewordRuntimeError(`Failed to initialize ONNX model session for ${modelPath}`, {
        cause,
      }),
  });

const makeFeatureSessionsWithOrt = (
  ort: OrtModule,
  assets: ResolvedWakewordAssets,
): Effect.Effect<WakewordFeatureSessions, WakewordRuntimeError> =>
  Effect.gen(function* () {
    const melspectrogram = yield* makeSession(ort, assets.melspectrogramModelPath).pipe(
      Effect.mapError(
        (cause) =>
          new WakewordRuntimeError(
            `Failed to initialize melspectrogram model '${assets.melspectrogramModelPath}'. Ensure real ONNX feature models are installed (not placeholders).`,
            { cause },
          ),
      ),
    );

    const embedding = yield* makeSession(ort, assets.embeddingModelPath).pipe(
      Effect.mapError(
        (cause) =>
          new WakewordRuntimeError(
            `Failed to initialize embedding model '${assets.embeddingModelPath}'. Ensure real ONNX feature models are installed (not placeholders).`,
            { cause },
          ),
      ),
    );

    return {
      melspectrogram,
      embedding,
    };
  });

const toOnnxScoringModel = (session: OnnxSession): WakewordScoringModel => {
  const requiredFrames =
    typeof session.inputDims[1] === "number" && Number.isFinite(session.inputDims[1])
      ? session.inputDims[1]
      : 16;

  const expectedFeatureSize =
    typeof session.inputDims[2] === "number" && Number.isFinite(session.inputDims[2])
      ? session.inputDims[2]
      : undefined;

  return {
    requiredFrames,
    ...(expectedFeatureSize !== undefined ? { expectedFeatureSize } : {}),
    score: (featureWindow) =>
      Effect.gen(function* () {
        if (featureWindow.length === 0) {
          return 0;
        }

        const actualFeatureSize = featureWindow[0]?.length ?? 0;
        const input = flattenMatrix(featureWindow);
        const output = yield* session.run({
          data: input,
          dims: [1, featureWindow.length, actualFeatureSize],
        });

        return output.data[output.data.length - 1] ?? 0;
      }),
  };
};

const loadLinearWakewordModel = (
  modelPath: string,
): Effect.Effect<WakewordScoringModel, WakewordRuntimeError> =>
  Effect.tryPromise({
    try: async () => {
      const raw = await fs.readFile(modelPath, "utf8");
      const parsed = JSON.parse(raw) as LinearWakewordModelFile;

      if (
        parsed.schemaVersion !== 1 ||
        parsed.type !== "linear_wakeword" ||
        !Number.isInteger(parsed.frameCount) ||
        parsed.frameCount <= 0 ||
        !Number.isInteger(parsed.featureSize) ||
        parsed.featureSize <= 0 ||
        !Array.isArray(parsed.weights) ||
        parsed.weights.length !== parsed.featureSize ||
        typeof parsed.bias !== "number" ||
        (parsed.logitScale !== undefined &&
          (typeof parsed.logitScale !== "number" ||
            !Number.isFinite(parsed.logitScale) ||
            parsed.logitScale <= 0))
      ) {
        throw new Error("Invalid linear wakeword model format");
      }

      const weights = Float32Array.from(parsed.weights);
      const inferredLogitScale = Math.max(1, Math.abs(parsed.bias) / 8);
      const logitScale = parsed.logitScale ?? inferredLogitScale;

      return {
        requiredFrames: parsed.frameCount,
        expectedFeatureSize: parsed.featureSize,
        score: (featureWindow) =>
          Effect.sync(() => {
            const featureCount = featureWindow[0]?.length ?? 0;
            if (featureCount !== parsed.featureSize) {
              throw new WakewordRuntimeError(
                `Linear wakeword model feature mismatch: expected ${parsed.featureSize}, got ${featureCount}`,
              );
            }

            const mean = new Float32Array(parsed.featureSize);
            for (const frame of featureWindow) {
              for (let index = 0; index < mean.length; index += 1) {
                mean[index] += frame[index] ?? 0;
              }
            }

            for (let index = 0; index < mean.length; index += 1) {
              mean[index] /= Math.max(1, featureWindow.length);
            }

            let rawScore = parsed.bias;
            for (let index = 0; index < mean.length; index += 1) {
              rawScore += (weights[index] ?? 0) * (mean[index] ?? 0);
            }

            return sigmoid(rawScore / logitScale);
          }),
      } satisfies WakewordScoringModel;
    },
    catch: (cause) =>
      new WakewordRuntimeError(`Failed to load linear wakeword model at ${modelPath}`, {
        cause,
      }),
  });

export const loadWakewordFeatureSessions = (
  assets: ResolvedWakewordAssets,
): Effect.Effect<WakewordFeatureSessions, WakewordRuntimeError> =>
  Effect.gen(function* () {
    const ort = yield* loadOrtModule(assets.runtimePackage).pipe(
      Effect.mapError(
        (cause) =>
          new WakewordRuntimeError(
            `Wakeword feature models require runtime '${assets.runtimePackage}@${assets.runtimeVersion}'. Install it before training or detection.`,
            { cause },
          ),
      ),
    );

    return yield* makeFeatureSessionsWithOrt(ort, assets);
  });

export const loadWakewordModelSessions = (
  assets: ResolvedWakewordAssets,
): Effect.Effect<WakewordModelSessions, WakewordRuntimeError> =>
  Effect.gen(function* () {
    const ort = yield* loadOrtModule(assets.runtimePackage).pipe(
      Effect.mapError(
        (cause) =>
          new WakewordRuntimeError(
            `Wakeword detection requires runtime '${assets.runtimePackage}@${assets.runtimeVersion}' and real ONNX feature models.`,
            { cause },
          ),
      ),
    );

    const features = yield* makeFeatureSessionsWithOrt(ort, assets);

    const wakewordEntries: Array<[string, WakewordScoringModel]> = [];

    for (const [name, modelPath] of Object.entries(assets.wakewordModelPaths)) {
      if (modelPath.endsWith(".onnx")) {
        const session = yield* makeSession(ort, modelPath);
        wakewordEntries.push([name, toOnnxScoringModel(session)]);
        continue;
      }

      if (modelPath.endsWith(".json")) {
        const model = yield* loadLinearWakewordModel(modelPath);
        wakewordEntries.push([name, model]);
        continue;
      }

      return yield* Effect.fail(
        new WakewordRuntimeError(
          `Unsupported wakeword model format for ${modelPath}. Supported extensions: .onnx, .json`,
        ),
      );
    }

    return {
      ...features,
      wakewords: Object.fromEntries(wakewordEntries),
    };
  });
