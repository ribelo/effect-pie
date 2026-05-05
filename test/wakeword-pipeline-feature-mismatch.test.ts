import { test } from "node:test"
import * as assert from "node:assert/strict"
import * as Effect from "effect/Effect"

import { makeWakewordPipeline, WakewordPipelineError } from "../src/wakeword/pipeline.ts"
import type { OnnxSession, WakewordModelSessions } from "../src/wakeword/onnx.ts"

const makeFakeSession = (
  inputDims: ReadonlyArray<number>,
  run: (input: Float32Array, dims: ReadonlyArray<number>) => Float32Array,
): OnnxSession => ({
  inputName: "input",
  inputDims,
  runPromise: async (input) => ({
    data: run(input.data, input.dims),
    dims: [1],
  }),
  run: (input) =>
    Effect.succeed({
      data: run(input.data, input.dims),
      dims: [1],
    }),
  dispose: Effect.void,
})

const toPcmBytes = (samples: Int16Array): Uint8Array => {
  const out = new Uint8Array(samples.length * 2)
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
  for (let index = 0; index < samples.length; index += 1) {
    view.setInt16(index * 2, samples[index] ?? 0, true)
  }
  return out
}

test("feature size mismatch fails loudly instead of silently skipping", async () => {
  const mismatchedModels: WakewordModelSessions = {
    melspectrogram: makeFakeSession([1, 1_280], (input) => {
      const frames = Math.max(1, Math.floor(input.length / 160))
      const bins = 32
      const out = new Float32Array(frames * bins)
      for (let frame = 0; frame < frames; frame += 1) {
        for (let bin = 0; bin < bins; bin += 1) {
          out[frame * bins + bin] = frame * 0.1 + bin * 0.01
        }
      }
      return out
    }),
    embedding: makeFakeSession([1, 76, 32, 1], (input) => {
      const out = new Float32Array(8)
      let sum = 0
      for (const value of input) {
        sum += value
      }
      const mean = sum / Math.max(1, input.length)
      for (let index = 0; index < out.length; index += 1) {
        out[index] = mean + index * 0.001
      }
      return out
    }),
    wakewords: {
      jarvis: {
        requiredFrames: 16,
        expectedFeatureSize: 99,
        scorePromise: async (featureWindow) => {
          const flattened = featureWindow.flatMap((frame) => Array.from(frame))
          const mean =
            flattened.reduce((acc, value) => acc + value, 0) / Math.max(1, flattened.length)
          return Math.max(0, Math.min(1, mean / 5))
        },
        score: (featureWindow) =>
          Effect.sync(() => {
            const flattened = featureWindow.flatMap((frame) => Array.from(frame))
            const mean =
              flattened.reduce((acc, value) => acc + value, 0) / Math.max(1, flattened.length)
            return Math.max(0, Math.min(1, mean / 5))
          }),
      },
    },
    dispose: Effect.void,
  }

  const pipeline = await Effect.runPromise(makeWakewordPipeline(mismatchedModels))

  const samples = Int16Array.from({ length: 1_280 * 30 }, (_, index) =>
    Math.round(Math.sin(index / 10) * 10_000),
  )

  let error: unknown = null
  try {
    await Effect.runPromise(pipeline.feedPcmChunk(toPcmBytes(samples)))
  } catch (caught) {
    error = caught
  }

  assert.ok(error instanceof WakewordPipelineError, "failure should be WakewordPipelineError")
  assert.ok(
    error.message.includes("jarvis"),
    `error message should include model name: ${error.message}`,
  )
  assert.ok(
    error.message.includes("99"),
    `error message should include expected size: ${error.message}`,
  )
  assert.ok(
    error.message.includes("8"),
    `error message should include actual size: ${error.message}`,
  )
})
