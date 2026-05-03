import { describe, test } from "node:test"
import * as assert from "node:assert/strict"
import * as Effect from "effect/Effect"

import { makeWakewordPipeline, type WakewordPipeline } from "../src/wakeword/pipeline.ts"
import type { OnnxSession, WakewordModelSessions } from "../src/wakeword/onnx.ts"

const makeFakeSession = (
  inputDims: ReadonlyArray<number>,
  run: (input: Float32Array, dims: ReadonlyArray<number>) => Float32Array,
): OnnxSession => ({
  inputName: "input",
  inputDims,
  run: (input) =>
    Effect.succeed({
      data: run(input.data, input.dims),
      dims: [1],
    }),
})

const fakeModels: WakewordModelSessions = {
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
      expectedFeatureSize: 8,
      score: (featureWindow) =>
        Effect.sync(() => {
          const flattened = featureWindow.flatMap((frame) => Array.from(frame))
          const mean =
            flattened.reduce((acc, value) => acc + value, 0) / Math.max(1, flattened.length)
          return Math.max(0, Math.min(1, mean / 5))
        }),
    },
  },
}

const toPcmBytes = (samples: Int16Array): Uint8Array => {
  const out = new Uint8Array(samples.length * 2)
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength)

  for (let index = 0; index < samples.length; index += 1) {
    view.setInt16(index * 2, samples[index] ?? 0, true)
  }

  return out
}

const chunkBytes = (input: Uint8Array, sizes: ReadonlyArray<number>): Array<Uint8Array> => {
  const chunks: Array<Uint8Array> = []
  let offset = 0
  let index = 0

  while (offset < input.length) {
    const size = sizes[index % sizes.length] ?? sizes[0] ?? input.length
    chunks.push(input.slice(offset, offset + size))
    offset += size
    index += 1
  }

  return chunks
}

const collectFrames = async (
  pipeline: WakewordPipeline,
  chunks: ReadonlyArray<Uint8Array>,
): Promise<ReadonlyArray<{ readonly timestampMs: number; readonly score: number }>> => {
  const collected: Array<{ readonly timestampMs: number; readonly score: number }> = []

  for (const chunk of chunks) {
    const frames = await Effect.runPromise(pipeline.feedPcmChunk(chunk))
    for (const frame of frames) {
      const score = frame.scores["jarvis"]
      if (score !== undefined) {
        collected.push({
          timestampMs: Number(frame.timestampMs.toFixed(3)),
          score: Number(score.toFixed(6)),
        })
      }
    }
  }

  return collected
}

describe("wakeword pipeline", () => {
  test("produces deterministic scores regardless of chunk boundaries", async () => {
    const samples = Int16Array.from({ length: 1_280 * 30 + 137 }, (_, index) =>
      Math.round(Math.sin(index / 10) * 10_000),
    )

    const bytes = toPcmBytes(samples)

    const mergedPipeline = await Effect.runPromise(makeWakewordPipeline(fakeModels))
    const splitPipeline = await Effect.runPromise(makeWakewordPipeline(fakeModels))

    const mergedFrames = await collectFrames(mergedPipeline, [bytes])
    const splitFrames = await collectFrames(splitPipeline, chunkBytes(bytes, [501, 777, 1281, 409]))

    assert.deepStrictEqual(splitFrames, mergedFrames)
    assert.ok(splitFrames.length > 0)
  })
})
