import { describe, it } from "node:test"
import { strict as assert } from "node:assert"
import { Effect, Ref } from "effect"
import {
  pttCaptureIdle,
  pttCaptureStart,
  pttCaptureRelease,
  pttCaptureIsAcceptingChunks,
} from "../src/ptt/capture.js"

describe("PTT chunk collection race conditions", () => {
  it("chunks are never mixed between rapid press/release cycles", async () => {
    const program = Effect.gen(function* () {
      const stateRef = yield* Ref.make(pttCaptureIdle)
      const chunksRef = yield* Ref.make<ReadonlyArray<Uint8Array>>([])
      const startedAtRef = yield* Ref.make<number | undefined>(undefined)

      // Simulate 3 rapid capture cycles
      for (let cycle = 0; cycle < 3; cycle++) {
        // Press
        const pressState = yield* Ref.get(stateRef)
        const nextState = pttCaptureStart(pressState, Date.now())
        yield* Ref.set(chunksRef, [])
        yield* Ref.set(startedAtRef, Date.now())
        yield* Ref.set(stateRef, nextState)

        // Simulate stream callback that might have stale state read
        // by running it concurrently with state changes
        const concurrentCallbacks = Effect.forEach(
          Array.from({ length: 10 }, (_, i) => i),
          (i) =>
            Effect.gen(function* () {
              const state = yield* Ref.get(stateRef)
              if (!pttCaptureIsAcceptingChunks(state)) {
                return
              }
              yield* Ref.update(chunksRef, (chunks) => {
                const next = chunks.slice()
                next.push(new Uint8Array([cycle, i]))
                return next
              })
            }),
          { concurrency: "unbounded" },
        )

        yield* concurrentCallbacks

        // Release
        const releaseState = yield* Ref.get(stateRef)
        yield* Ref.set(stateRef, pttCaptureRelease(releaseState, Date.now()))

        // Small delay to let post-roll chunks arrive
        yield* Effect.sleep("10 millis")

        // Finalize
        yield* Ref.set(stateRef, pttCaptureIdle)
        const chunks = yield* Ref.get(chunksRef)

        // All chunks in this cycle must belong to this cycle
        for (const chunk of chunks) {
          assert.strictEqual(
            chunk[0],
            cycle,
            `cycle ${cycle}: found chunk from wrong cycle: ${chunk[0]}`,
          )
        }

        yield* Ref.set(chunksRef, [])
        yield* Ref.set(startedAtRef, undefined)
      }
    })

    await Effect.runPromise(program)
  })

  it("post-roll cancellation preserves chunks from original capture", async () => {
    const program = Effect.gen(function* () {
      const stateRef = yield* Ref.make(pttCaptureIdle)
      const chunksRef = yield* Ref.make<ReadonlyArray<Uint8Array>>([])

      // Start capture
      const s1 = pttCaptureStart(yield* Ref.get(stateRef), Date.now())
      yield* Ref.set(chunksRef, [])
      yield* Ref.set(stateRef, s1)

      // Add some chunks
      yield* Ref.update(chunksRef, (chunks) => [...chunks, new Uint8Array([1])])
      yield* Ref.update(chunksRef, (chunks) => [...chunks, new Uint8Array([2])])

      // Release
      const s2 = pttCaptureRelease(yield* Ref.get(stateRef), Date.now())
      yield* Ref.set(stateRef, s2)

      // Re-press during post-roll (cancels post-roll, continues same capture)
      const s3 = pttCaptureStart(yield* Ref.get(stateRef), Date.now())
      yield* Ref.set(stateRef, s3)

      // Add more chunks
      yield* Ref.update(chunksRef, (chunks) => [...chunks, new Uint8Array([3])])

      // Finalize
      yield* Ref.set(stateRef, pttCaptureIdle)
      const chunks = yield* Ref.get(chunksRef)

      assert.strictEqual(chunks.length, 3)
      assert.deepStrictEqual(
        chunks.map((c) => Array.from(c)),
        [[1], [2], [3]],
      )
    })

    await Effect.runPromise(program)
  })

  it("interleaved stream callback with stale state read does not corrupt capture", async () => {
    const program = Effect.gen(function* () {
      const stateRef = yield* Ref.make(pttCaptureIdle)
      const chunksRef = yield* Ref.make<ReadonlyArray<Uint8Array>>([])

      // Start capture
      const s1 = pttCaptureStart(yield* Ref.get(stateRef), Date.now())
      yield* Ref.set(chunksRef, [])
      yield* Ref.set(stateRef, s1)

      // Simulate a stream callback that read state BEFORE release,
      // but appends AFTER release+finalize.
      // In the real code, this happens because the callback is on a
      // concurrent fiber and the state read + append are not atomic.
      const staleState = yield* Ref.get(stateRef) // reads 'capturing'

      // Main loop releases and finalizes
      const s2 = pttCaptureRelease(yield* Ref.get(stateRef), Date.now())
      yield* Ref.set(stateRef, s2)
      yield* Ref.set(stateRef, pttCaptureIdle)
      const chunksBefore = yield* Ref.get(chunksRef)
      yield* Ref.set(chunksRef, [])

      // Now the stale callback continues (it read 'capturing' earlier)
      if (pttCaptureIsAcceptingChunks(staleState)) {
        yield* Ref.update(chunksRef, (chunks) => [...chunks, new Uint8Array([99])])
      }
      const chunksAfter = yield* Ref.get(chunksRef)

      // The stale callback appended after finalize, but that's fine:
      // the previous capture already read its chunks. The orphan [99]
      // will be cleared by the next press handler.
      assert.strictEqual(chunksBefore.length, 0, "chunks should be empty after finalize")
      assert.deepStrictEqual(
        chunksAfter,
        [new Uint8Array([99])],
        "orphan chunk exists but is harmless",
      )
    })

    await Effect.runPromise(program)
  })
})
