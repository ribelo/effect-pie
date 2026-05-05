import { test } from "node:test"
import * as assert from "node:assert/strict"
import * as Effect from "effect/Effect"

import { makeSession, type OrtModule } from "../src/wakeword/onnx.ts"
import type { InferenceSession, Tensor } from "onnxruntime-web"

const makeMockOrt = (releaseSpy: () => void): OrtModule => ({
  InferenceSession: {
    create: async (_path: string, _options?: Record<string, unknown>) =>
      ({
        inputNames: ["input"],
        outputNames: ["output"],
        inputMetadata: [{ name: "input", dimensions: [1, 1280] }],
        run: async () =>
          ({
            output: { data: new Float32Array([1, 2, 3]), dims: [3] },
          }) as unknown as Record<string, unknown>,
        release: async () => releaseSpy(),
      }) as unknown as InferenceSession,
  },
  Tensor: class {
    data: Float32Array
    constructor(_type: string, data: Float32Array, _dims: ReadonlyArray<number>) {
      this.data = data
    }
  } as unknown as new (type: string, data: Float32Array, dims: ReadonlyArray<number>) => Tensor,
})

test("makeSession exposes dispose that calls underlying release", async () => {
  let released = false
  const ort = makeMockOrt(() => {
    released = true
  })

  const session = await Effect.runPromise(makeSession(ort, "/fake/model.onnx"))
  assert.ok(session.dispose !== undefined, "session should have dispose")

  await Effect.runPromise(session.dispose)
  assert.ok(released, "dispose should call underlying release")
})
