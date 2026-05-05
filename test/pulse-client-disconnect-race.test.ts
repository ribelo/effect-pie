import { test } from "node:test"
import * as assert from "node:assert/strict"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Ref from "effect/Ref"
import * as Scope from "effect/Scope"

/**
 * Models the disconnectCurrent / connect race: if stateRef is cleared before
 * cleanup finishes, a concurrent connect() sees null and creates a new
 * connection while the old one is still being torn down.
 */
test("state should not be cleared until after scope cleanup", async () => {
  const program = Effect.gen(function* () {
    const stateRef = yield* Ref.make<{ id: number; scope: Scope.Closeable } | null>(null)
    let createCount = 0

    const makeConnection = Effect.gen(function* () {
      createCount++
      const scope = yield* Scope.make()
      yield* Scope.addFinalizer(scope, Effect.sleep("100 millis"))
      const conn = { id: createCount, scope }
      yield* Ref.set(stateRef, conn)
      return conn
    })

    const disconnectCurrent = Effect.gen(function* () {
      const current = yield* Ref.get(stateRef)
      if (current === null) return

      // FIXED: cleanup before clearing state
      yield* Scope.close(current.scope, Exit.void)
      yield* Ref.set(stateRef, null)
    })

    const connect = Effect.gen(function* () {
      const existing = yield* Ref.get(stateRef)
      if (existing !== null) return
      yield* makeConnection
    })

    // Create initial connection
    yield* makeConnection
    assert.equal(createCount, 1)

    // Fork disconnect (slow cleanup), then immediately run connect
    const disconnectFiber = yield* Effect.forkChild(disconnectCurrent, { startImmediately: true })
    yield* connect
    yield* Fiber.join(disconnectFiber)

    // With the fix, connect sees existing during teardown and returns early.
    // With the bug (set null before cleanup), connect creates a second conn.
    assert.equal(createCount, 1, "connect should not create a new connection during teardown")
  })

  await Effect.runPromise(program)
})

test("bug pattern: clearing state before cleanup allows reconnect race", async () => {
  const program = Effect.gen(function* () {
    const stateRef = yield* Ref.make<{ id: number; scope: Scope.Closeable } | null>(null)
    let createCount = 0

    const makeConnection = Effect.gen(function* () {
      createCount++
      const scope = yield* Scope.make()
      yield* Scope.addFinalizer(scope, Effect.sleep("100 millis"))
      const conn = { id: createCount, scope }
      yield* Ref.set(stateRef, conn)
      return conn
    })

    const disconnectCurrentBug = Effect.gen(function* () {
      const current = yield* Ref.get(stateRef)
      if (current === null) return

      // BUG: clear state before cleanup
      yield* Ref.set(stateRef, null)
      yield* Scope.close(current.scope, Exit.void)
    })

    const connect = Effect.gen(function* () {
      const existing = yield* Ref.get(stateRef)
      if (existing !== null) return
      yield* makeConnection
    })

    yield* makeConnection
    assert.equal(createCount, 1)

    // Fork disconnect (slow cleanup), then immediately run connect
    const disconnectFiber = yield* Effect.forkChild(disconnectCurrentBug, {
      startImmediately: true,
    })
    yield* connect
    yield* Fiber.join(disconnectFiber)

    // Bug pattern allows a second connection to be created
    assert.equal(createCount, 2, "bug pattern should allow race-condition reconnect")
  })

  await Effect.runPromise(program)
})
