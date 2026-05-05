import * as Data from "effect/Data"
import * as Effect from "effect/Effect"

import { decodeS16leSamples } from "../audio/pcm.js"
import {
  OPENWAKEWORD_FEATURE_HISTORY_FRAMES,
  OPENWAKEWORD_LOOKBACK_SAMPLES,
  OPENWAKEWORD_MEL_BINS,
  OPENWAKEWORD_MEL_HISTORY_FRAMES,
  OPENWAKEWORD_MEL_WINDOW_FRAMES,
  OPENWAKEWORD_PCM_BYTES_PER_SAMPLE,
  OPENWAKEWORD_PCM_FRAME_SAMPLES,
  OPENWAKEWORD_SAMPLE_RATE,
  type WakewordScoreFrame,
} from "./defs.js"
import type { OnnxSession, WakewordModelSessions } from "./onnx.js"
import { flattenMatrix, toFrameMatrix, transformMelspectrogram } from "./signal.js"

export class WakewordPipelineError extends Data.TaggedError("WakewordPipelineError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

export type WakewordPipelineConfig = {
  readonly sampleRate?: number
  readonly frameSamples?: number
  readonly melBins?: number
  readonly melWindowFrames?: number
  readonly melHistoryFrames?: number
  readonly featureHistoryFrames?: number
  readonly lookbackSamples?: number
  readonly defaultWakewordInputFrames?: number
}

export type WakewordPipeline = {
  readonly feedPcmChunk: (
    chunk: Uint8Array,
  ) => Effect.Effect<ReadonlyArray<WakewordScoreFrame>, WakewordPipelineError>
  readonly feedPcmSamples: (
    samples: Int16Array,
  ) => Effect.Effect<ReadonlyArray<WakewordScoreFrame>, WakewordPipelineError>
  readonly getFeatureFrameCount: Effect.Effect<number>
  readonly reset: Effect.Effect<void>
}

type PipelineState = {
  byteRemainder: Uint8Array
  sampleRemainder: Int16Array
  rawSampleBuffer: Array<number>
  melBuffer: Array<Float32Array>
  featureBuffer: Array<Float32Array>
  totalProcessedSamples: number
}

type ResolvedPipelineConfig = {
  readonly sampleRate: number
  readonly frameSamples: number
  readonly melBins: number
  readonly melWindowFrames: number
  readonly melHistoryFrames: number
  readonly featureHistoryFrames: number
  readonly lookbackSamples: number
  readonly defaultWakewordInputFrames: number
}

const resolveConfig = (config: WakewordPipelineConfig): ResolvedPipelineConfig => ({
  sampleRate: config.sampleRate ?? OPENWAKEWORD_SAMPLE_RATE,
  frameSamples: config.frameSamples ?? OPENWAKEWORD_PCM_FRAME_SAMPLES,
  melBins: config.melBins ?? OPENWAKEWORD_MEL_BINS,
  melWindowFrames: config.melWindowFrames ?? OPENWAKEWORD_MEL_WINDOW_FRAMES,
  melHistoryFrames: config.melHistoryFrames ?? OPENWAKEWORD_MEL_HISTORY_FRAMES,
  featureHistoryFrames: config.featureHistoryFrames ?? OPENWAKEWORD_FEATURE_HISTORY_FRAMES,
  lookbackSamples: config.lookbackSamples ?? OPENWAKEWORD_LOOKBACK_SAMPLES,
  defaultWakewordInputFrames: config.defaultWakewordInputFrames ?? 16,
})

const makeInitialMelBuffer = (frames: number, bins: number): Array<Float32Array> =>
  Array.from({ length: frames }, () => Float32Array.from({ length: bins }, () => 1))

const trimArrayInPlace = (target: Array<unknown>, maxLength: number): void => {
  if (target.length <= maxLength) {
    return
  }
  target.splice(0, target.length - maxLength)
}

const toPcmSamples = (bytes: Uint8Array): Int16Array => decodeS16leSamples(bytes)

const concatInt16 = (left: Int16Array, right: Int16Array): Int16Array => {
  if (left.length === 0) {
    return right
  }
  if (right.length === 0) {
    return left
  }

  const out = new Int16Array(left.length + right.length)
  out.set(left, 0)
  out.set(right, left.length)
  return out
}

const runSessionHot = async (
  session: OnnxSession,
  inputData: Float32Array,
  inputDims: ReadonlyArray<number>,
  errorMessage: string,
): Promise<Float32Array> => {
  try {
    const output = await session.runPromise({
      data: inputData,
      dims: inputDims,
    })
    return output.data
  } catch (cause) {
    throw new WakewordPipelineError({
      message: errorMessage,
      cause,
    })
  }
}

export const makeWakewordPipeline = Effect.fn("pie/wakeword/pipeline.makeWakewordPipeline")(
  function* (
    models: WakewordModelSessions,
    config: WakewordPipelineConfig = {},
  ): Effect.fn.Return<WakewordPipeline> {
    return yield* Effect.sync(() => {
      const resolved = resolveConfig(config)

      const state: PipelineState = {
        byteRemainder: new Uint8Array(),
        sampleRemainder: new Int16Array(),
        rawSampleBuffer: [],
        melBuffer: makeInitialMelBuffer(resolved.melWindowFrames, resolved.melBins),
        featureBuffer: [],
        totalProcessedSamples: 0,
      }

      const feedPcmSamplesPromise = async (
        incoming: Int16Array,
      ): Promise<ReadonlyArray<WakewordScoreFrame>> => {
        const mergedSamples = concatInt16(state.sampleRemainder, incoming)
        const processableSamples =
          mergedSamples.length - (mergedSamples.length % resolved.frameSamples)

        state.sampleRemainder = mergedSamples.slice(processableSamples)

        if (processableSamples === 0) {
          return []
        }

        const nextSamples = mergedSamples.slice(0, processableSamples)
        const scoreFrames: Array<WakewordScoreFrame> = []

        for (let offset = 0; offset < nextSamples.length; offset += resolved.frameSamples) {
          const frameChunk = nextSamples.slice(offset, offset + resolved.frameSamples)

          for (const sample of frameChunk) {
            state.rawSampleBuffer.push(sample)
          }

          const maxRawSamples = resolved.sampleRate * 10
          trimArrayInPlace(state.rawSampleBuffer, maxRawSamples)

          state.totalProcessedSamples += resolved.frameSamples

          const bufferedInput = state.rawSampleBuffer.slice(
            Math.max(
              0,
              state.rawSampleBuffer.length - resolved.frameSamples - resolved.lookbackSamples,
            ),
          )

          const melInput = Float32Array.from(bufferedInput)
          const melOutput = await runSessionHot(
            models.melspectrogram,
            melInput,
            [1, melInput.length],
            "Wakeword melspectrogram inference failed",
          )
          const transformed = transformMelspectrogram(melOutput)
          const melFrames = toFrameMatrix(transformed, resolved.melBins)

          state.melBuffer.push(...melFrames)
          trimArrayInPlace(state.melBuffer, resolved.melHistoryFrames)

          const melWindow = state.melBuffer.slice(-resolved.melWindowFrames)
          if (melWindow.length !== resolved.melWindowFrames) {
            continue
          }

          const embeddingInput = flattenMatrix(melWindow)
          const embeddingOutput = await runSessionHot(
            models.embedding,
            embeddingInput,
            [1, resolved.melWindowFrames, resolved.melBins, 1],
            "Wakeword embedding inference failed",
          )

          const embeddingVector =
            embeddingOutput.length === 0 ? new Float32Array() : embeddingOutput
          if (embeddingVector.length === 0) {
            continue
          }

          state.featureBuffer.push(embeddingVector)
          trimArrayInPlace(state.featureBuffer, resolved.featureHistoryFrames)

          const scores: Record<string, number> = {}

          for (const [name, model] of Object.entries(models.wakewords)) {
            const requiredFrames = model.requiredFrames ?? resolved.defaultWakewordInputFrames
            if (state.featureBuffer.length < requiredFrames) {
              continue
            }

            const featureWindow = state.featureBuffer.slice(
              state.featureBuffer.length - requiredFrames,
            )
            const actualFeatureSize = featureWindow[0]?.length ?? 0

            if (
              model.expectedFeatureSize !== undefined &&
              model.expectedFeatureSize !== actualFeatureSize
            ) {
              throw new WakewordPipelineError({
                message: `Wakeword model '${name}' feature size mismatch: expected ${model.expectedFeatureSize}, got ${actualFeatureSize}`,
              })
            }

            try {
              scores[name] = await model.scorePromise(featureWindow)
            } catch (cause) {
              throw new WakewordPipelineError({
                message: `Wakeword scoring model '${name}' inference failed`,
                cause,
              })
            }
          }

          scoreFrames.push({
            timestampMs: (state.totalProcessedSamples / resolved.sampleRate) * 1000,
            sampleIndex: state.totalProcessedSamples,
            scores,
          })
        }

        return scoreFrames
      }

      const feedPcmSamples = (
        incoming: Int16Array,
      ): Effect.Effect<ReadonlyArray<WakewordScoreFrame>, WakewordPipelineError> =>
        Effect.tryPromise({
          try: () => feedPcmSamplesPromise(incoming),
          catch: (cause) =>
            cause instanceof WakewordPipelineError
              ? cause
              : new WakewordPipelineError({
                  message: "Wakeword pipeline processing failed",
                  cause,
                }),
        })

      const feedPcmChunk = (
        chunk: Uint8Array,
      ): Effect.Effect<ReadonlyArray<WakewordScoreFrame>, WakewordPipelineError> =>
        Effect.tryPromise({
          try: async () => {
            const merged =
              state.byteRemainder.length === 0
                ? chunk
                : (() => {
                    const out = new Uint8Array(state.byteRemainder.length + chunk.length)
                    out.set(state.byteRemainder, 0)
                    out.set(chunk, state.byteRemainder.length)
                    return out
                  })()

            const alignedLength =
              merged.length - (merged.length % OPENWAKEWORD_PCM_BYTES_PER_SAMPLE)
            const aligned = merged.slice(0, alignedLength)
            state.byteRemainder = merged.slice(alignedLength)

            if (aligned.length === 0) {
              return []
            }

            return await feedPcmSamplesPromise(toPcmSamples(aligned))
          },
          catch: (cause) =>
            cause instanceof WakewordPipelineError
              ? cause
              : new WakewordPipelineError({
                  message: "Wakeword pipeline processing failed",
                  cause,
                }),
        })

      return {
        feedPcmChunk,
        feedPcmSamples,
        getFeatureFrameCount: Effect.sync(() => state.featureBuffer.length),
        reset: Effect.sync(() => {
          state.byteRemainder = new Uint8Array()
          state.sampleRemainder = new Int16Array()
          state.rawSampleBuffer = []
          state.melBuffer = makeInitialMelBuffer(resolved.melWindowFrames, resolved.melBins)
          state.featureBuffer = []
          state.totalProcessedSamples = 0
        }),
      }
    })
  },
)
