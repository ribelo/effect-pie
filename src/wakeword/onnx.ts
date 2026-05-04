import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import { promises as fs } from "node:fs"

import type { ResolvedWakewordAssets } from "./defs.js"
import { isRecord } from "../utils/runtime.js"
import { flattenMatrix } from "./signal.js"

export class WakewordRuntimeError extends Data.TaggedError("WakewordRuntimeError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

export type OnnxTensorData = {
  readonly data: Float32Array
  readonly dims: ReadonlyArray<number>
}

export type OnnxSession = {
  readonly inputName: string
  readonly inputDims: ReadonlyArray<number | string | null | undefined>
  readonly run: (input: OnnxTensorData) => Effect.Effect<OnnxTensorData, WakewordRuntimeError>
}

export type WakewordScoringModel = {
  readonly requiredFrames: number
  readonly expectedFeatureSize?: number
  readonly score: (
    featureWindow: ReadonlyArray<Float32Array>,
  ) => Effect.Effect<number, WakewordRuntimeError>
}

export type WakewordFeatureSessions = {
  readonly melspectrogram: OnnxSession
  readonly embedding: OnnxSession
}

export type WakewordModelSessions = WakewordFeatureSessions & {
  readonly wakewords: Readonly<Record<string, WakewordScoringModel>>
}

type OrtModule = {
  readonly InferenceSession: {
    create: (modelPath: string, options?: Record<string, unknown>) => Promise<unknown>
  }
  readonly Tensor: new (type: string, data: Float32Array, dims: ReadonlyArray<number>) => unknown
}

type OrtSession = {
  readonly inputNames?: ReadonlyArray<string>
  readonly outputNames?: ReadonlyArray<string>
  readonly inputMetadata?: Record<string, { readonly dimensions?: ReadonlyArray<number | string> }>
  readonly run: (feeds: Record<string, unknown>) => Promise<Record<string, unknown>>
}

type OrtTensor = {
  readonly data?: Float32Array | ReadonlyArray<number>
  readonly dims?: ReadonlyArray<number>
}

type LinearWakewordModelFile = {
  readonly schemaVersion: 1
  readonly type: "linear_wakeword"
  readonly frameCount: number
  readonly featureSize: number
  readonly weights: ReadonlyArray<number>
  readonly bias: number
  readonly logitScale?: number
}

const isOrtModule = (value: unknown): value is OrtModule =>
  isRecord(value) &&
  isRecord(value["InferenceSession"]) &&
  typeof value["InferenceSession"]["create"] === "function" &&
  typeof value["Tensor"] === "function"

const isOrtSession = (value: unknown): value is OrtSession =>
  isRecord(value) && typeof value["run"] === "function"

const isOrtTensor = (value: unknown): value is OrtTensor =>
  isRecord(value) &&
  (value["data"] instanceof Float32Array ||
    (Array.isArray(value["data"]) && value["data"].every((entry) => typeof entry === "number")))

const isLinearWakewordModelFile = (value: unknown): value is LinearWakewordModelFile => {
  if (!isRecord(value)) {
    return false
  }

  const logitScale = value["logitScale"]

  return (
    value["schemaVersion"] === 1 &&
    value["type"] === "linear_wakeword" &&
    Number.isInteger(value["frameCount"]) &&
    typeof value["frameCount"] === "number" &&
    value["frameCount"] > 0 &&
    Number.isInteger(value["featureSize"]) &&
    typeof value["featureSize"] === "number" &&
    value["featureSize"] > 0 &&
    Array.isArray(value["weights"]) &&
    value["weights"].every((entry) => typeof entry === "number") &&
    value["weights"].length === value["featureSize"] &&
    typeof value["bias"] === "number" &&
    (logitScale === undefined ||
      (typeof logitScale === "number" && Number.isFinite(logitScale) && logitScale > 0))
  )
}

const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x))

const toFloat32Array = (value: Float32Array | ReadonlyArray<number>): Float32Array =>
  value instanceof Float32Array ? value : Float32Array.from(value)

const readOutputTensor = (outputs: Record<string, unknown>, outputName: string): OrtTensor => {
  const output = outputs[outputName] ?? Object.values(outputs)[0]
  if (!isOrtTensor(output)) {
    throw new WakewordRuntimeError({
      message: `Model did not produce tensor output '${outputName}'`,
    })
  }
  return output
}

const loadOrtModule = (runtimePackage: string): Effect.Effect<OrtModule, WakewordRuntimeError> =>
  Effect.tryPromise({
    try: async () => {
      const module: unknown = await import(runtimePackage)
      if (!isOrtModule(module)) {
        throw new WakewordRuntimeError({
          message: `ONNX runtime package '${runtimePackage}' did not expose the expected API`,
        })
      }
      return module
    },
    catch: (cause) =>
      new WakewordRuntimeError({
        message: `Unable to load ONNX runtime package '${runtimePackage}'. Run bun install and ensure runtime assets are pinned.`,
        cause,
      }),
  })

const makeSession = (
  ort: OrtModule,
  modelPath: string,
): Effect.Effect<OnnxSession, WakewordRuntimeError> =>
  Effect.tryPromise({
    try: async () => {
      const session = await ort.InferenceSession.create(modelPath, {
        executionProviders: ["wasm"],
      })

      if (!isOrtSession(session)) {
        throw new WakewordRuntimeError({
          message: `ONNX model session for ${modelPath} did not expose the expected API`,
        })
      }

      const inputName = session.inputNames?.[0]
      const outputName = session.outputNames?.[0]

      if (
        inputName === undefined ||
        inputName.length === 0 ||
        outputName === undefined ||
        outputName.length === 0
      ) {
        throw new WakewordRuntimeError({
          message: `Could not inspect ONNX model IO metadata for ${modelPath}`,
        })
      }

      const inputDims = session.inputMetadata?.[inputName]?.dimensions ?? []

      return {
        inputName,
        inputDims,
        run: (input) =>
          Effect.tryPromise({
            try: async () => {
              const tensor = new ort.Tensor("float32", input.data, input.dims)
              const outputs = await session.run({ [inputName]: tensor })
              const output = readOutputTensor(outputs, outputName)
              const outputData = output.data
              if (!outputData) {
                throw new WakewordRuntimeError({
                  message: `Model output '${outputName}' is missing tensor data`,
                })
              }

              const data = toFloat32Array(outputData)

              return {
                data,
                dims: output.dims ?? [data.length],
              }
            },
            catch: (cause) =>
              new WakewordRuntimeError({
                message: `ONNX inference failed for model ${modelPath}`,
                cause,
              }),
          }),
      } satisfies OnnxSession
    },
    catch: (cause) =>
      new WakewordRuntimeError({
        message: `Failed to initialize ONNX model session for ${modelPath}`,
        cause,
      }),
  })

const makeFeatureSessionsWithOrt = (
  ort: OrtModule,
  assets: ResolvedWakewordAssets,
): Effect.Effect<WakewordFeatureSessions, WakewordRuntimeError> =>
  Effect.gen(function* () {
    const melspectrogram = yield* makeSession(ort, assets.melspectrogramModelPath).pipe(
      Effect.mapError(
        (cause) =>
          new WakewordRuntimeError({
            message: `Failed to initialize melspectrogram model '${assets.melspectrogramModelPath}'. Ensure real ONNX feature models are installed (not placeholders).`,
            cause,
          }),
      ),
    )

    const embedding = yield* makeSession(ort, assets.embeddingModelPath).pipe(
      Effect.mapError(
        (cause) =>
          new WakewordRuntimeError({
            message: `Failed to initialize embedding model '${assets.embeddingModelPath}'. Ensure real ONNX feature models are installed (not placeholders).`,
            cause,
          }),
      ),
    )

    return {
      melspectrogram,
      embedding,
    }
  })

const toOnnxScoringModel = (session: OnnxSession): WakewordScoringModel => {
  const requiredFrames =
    typeof session.inputDims[1] === "number" && Number.isFinite(session.inputDims[1])
      ? session.inputDims[1]
      : 16

  const expectedFeatureSize =
    typeof session.inputDims[2] === "number" && Number.isFinite(session.inputDims[2])
      ? session.inputDims[2]
      : undefined

  return {
    requiredFrames,
    ...(expectedFeatureSize !== undefined ? { expectedFeatureSize } : {}),
    score: (featureWindow) =>
      Effect.gen(function* () {
        if (featureWindow.length === 0) {
          return 0
        }

        const actualFeatureSize = featureWindow[0]?.length ?? 0
        const input = flattenMatrix(featureWindow)
        const output = yield* session.run({
          data: input,
          dims: [1, featureWindow.length, actualFeatureSize],
        })

        return output.data[output.data.length - 1] ?? 0
      }),
  }
}

export const loadLinearWakewordModel = (
  modelPath: string,
): Effect.Effect<WakewordScoringModel, WakewordRuntimeError> =>
  Effect.gen(function* () {
    const raw = yield* Effect.promise(() => fs.readFile(modelPath, "utf8")).pipe(
      Effect.mapError(
        (cause) =>
          new WakewordRuntimeError({
            message: `Failed to load linear wakeword model at ${modelPath}`,
            cause,
          }),
      ),
    )

    const parsed: unknown = JSON.parse(raw)

    if (!isLinearWakewordModelFile(parsed)) {
      return yield* new WakewordRuntimeError({
        message: "Invalid linear wakeword model format",
      })
    }

    const weights = Float32Array.from(parsed.weights)
    const inferredLogitScale = Math.max(1, Math.abs(parsed.bias) / 8)
    const logitScale = parsed.logitScale ?? inferredLogitScale

    return {
      requiredFrames: parsed.frameCount,
      expectedFeatureSize: parsed.featureSize,
      score: (featureWindow) =>
        Effect.sync(() => {
          const featureCount = featureWindow[0]?.length ?? 0
          if (featureCount !== parsed.featureSize) {
            throw new WakewordRuntimeError({
              message: `Linear wakeword model feature mismatch: expected ${parsed.featureSize}, got ${featureCount}`,
            })
          }

          const mean = new Float32Array(parsed.featureSize)
          for (const frame of featureWindow) {
            for (let index = 0; index < mean.length; index += 1) {
              mean[index] = (mean[index] ?? 0) + (frame[index] ?? 0)
            }
          }

          for (let index = 0; index < mean.length; index += 1) {
            mean[index] = (mean[index] ?? 0) / Math.max(1, featureWindow.length)
          }

          let rawScore = parsed.bias
          for (let index = 0; index < mean.length; index += 1) {
            rawScore += (weights[index] ?? 0) * (mean[index] ?? 0)
          }

          return sigmoid(rawScore / logitScale)
        }),
    } satisfies WakewordScoringModel
  })

export const loadWakewordFeatureSessions = (
  assets: ResolvedWakewordAssets,
): Effect.Effect<WakewordFeatureSessions, WakewordRuntimeError> =>
  Effect.gen(function* () {
    const ort = yield* loadOrtModule(assets.runtimePackage).pipe(
      Effect.mapError(
        (cause) =>
          new WakewordRuntimeError({
            message: `Wakeword feature models require runtime '${assets.runtimePackage}@${assets.runtimeVersion}'. Install it before training or detection.`,
            cause,
          }),
      ),
    )

    return yield* makeFeatureSessionsWithOrt(ort, assets)
  })

export const loadWakewordModelSessions = (
  assets: ResolvedWakewordAssets,
): Effect.Effect<WakewordModelSessions, WakewordRuntimeError> =>
  Effect.gen(function* () {
    const ort = yield* loadOrtModule(assets.runtimePackage).pipe(
      Effect.mapError(
        (cause) =>
          new WakewordRuntimeError({
            message: `Wakeword detection requires runtime '${assets.runtimePackage}@${assets.runtimeVersion}' and real ONNX feature models.`,
            cause,
          }),
      ),
    )

    const features = yield* makeFeatureSessionsWithOrt(ort, assets)

    const wakewordEntries: Array<[string, WakewordScoringModel]> = []

    for (const [name, modelPath] of Object.entries(assets.wakewordModelPaths)) {
      if (modelPath.endsWith(".onnx")) {
        const session = yield* makeSession(ort, modelPath)
        wakewordEntries.push([name, toOnnxScoringModel(session)])
        continue
      }

      if (modelPath.endsWith(".json")) {
        const model = yield* loadLinearWakewordModel(modelPath)
        wakewordEntries.push([name, model])
        continue
      }

      return yield* new WakewordRuntimeError({
        message: `Unsupported wakeword model format for ${modelPath}. Supported extensions: .onnx, .json`,
      })
    }

    return {
      ...features,
      wakewords: Object.fromEntries(wakewordEntries),
    }
  })
