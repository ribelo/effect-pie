import { test } from "node:test"
import * as assert from "node:assert/strict"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Ref from "effect/Ref"
import * as Scope from "effect/Scope"

class TestAuthError extends Data.TaggedError("TestAuthError")<{
  readonly message: string
}> {}

const buildMakeConnection = (scopeClosedRef: Ref.Ref<boolean>, shouldFail: boolean) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make()

    yield* Effect.gen(function* () {
      yield* Scope.addFinalizer(scope, Ref.set(scopeClosedRef, true))
      if (shouldFail) {
        return yield* new TestAuthError({ message: "socket writer failed" })
      }
      return { id: 1 }
    }).pipe(
      Effect.onExit((exit) => (Exit.isFailure(exit) ? Scope.close(scope, exit) : Effect.void)),
    )
  })

test("partial failure after Scope.make closes scope via onExit", async () => {
  const program = Effect.gen(function* () {
    const scopeClosedRef = yield* Ref.make(false)
    const makeConnection = buildMakeConnection(scopeClosedRef, true)

    const result = yield* makeConnection.pipe(Effect.exit)
    assert.ok(Exit.isFailure(result), "makeConnection should fail")

    const closed = yield* Ref.get(scopeClosedRef)
    assert.equal(closed, true, "scope should be closed by onExit on failure")
  })

  await Effect.runPromise(program)
})

test("partial failure without onExit leaves scope open", async () => {
  const program = Effect.gen(function* () {
    const scopeClosedRef = yield* Ref.make(false)

    const makeConnection = Effect.gen(function* () {
      const scope = yield* Scope.make()
      yield* Scope.addFinalizer(scope, Ref.set(scopeClosedRef, true))
      return yield* new TestAuthError({ message: "socket writer failed" })
    })

    const result = yield* makeConnection.pipe(Effect.exit)
    assert.ok(Exit.isFailure(result), "makeConnection should fail")

    const closed = yield* Ref.get(scopeClosedRef)
    assert.equal(closed, false, "scope should not be closed without explicit cleanup")
  })

  await Effect.runPromise(program)
})
