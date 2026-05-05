import { test } from "node:test"
import * as assert from "node:assert/strict"
import * as Effect from "effect/Effect"
import * as Ref from "effect/Ref"
import * as Semaphore from "effect/Semaphore"

test("semaphore serialization prevents concurrent connection creation", async () => {
  const program = Effect.gen(function* () {
    const stateRef = yield* Ref.make<{ id: number } | null>(null)
    const semaphore = yield* Semaphore.make(1)
    let createCount = 0

    const makeConnection = Effect.gen(function* () {
      createCount++
      yield* Effect.sleep("20 millis")
      return { id: createCount }
    })

    const connect = semaphore.withPermits(1)(
      Effect.gen(function* () {
        const existing = yield* Ref.get(stateRef)
        if (existing !== null) return
        const connection = yield* makeConnection
        yield* Ref.set(stateRef, connection)
      }),
    )

    yield* Effect.all([connect, connect], { concurrency: 2 })
    yield* Effect.sleep("50 millis")

    assert.equal(createCount, 1, `expected 1 connection, got ${createCount}`)
  })

  await Effect.runPromise(program)
})
