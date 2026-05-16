import { test } from "node:test"
import * as assert from "node:assert/strict"
import { Effect, Logger, References, Result } from "effect"

import { RecordingCoordinator } from "../src/commands/assistant/coordinator.js"

test("assistant error path emits structured log with coordinator snapshot", async () => {
  const logs: Array<{
    readonly message: unknown
    readonly annotations: Record<string, unknown>
    readonly logLevel: string
  }> = []

  const fakeLogger = Logger.make((options) => {
    logs.push({
      message: options.message,
      annotations: { ...options.fiber.getRef(References.CurrentLogAnnotations) },
      logLevel: options.logLevel,
    })
  })

  const coordinatorLayer = RecordingCoordinator.live()

  const failEffect = Effect.gen(function* () {
    const coordinator = yield* RecordingCoordinator
    yield* coordinator.tryStart("ptt-transcribe")
    return yield* Effect.fail(new Error("synthetic assistant failure"))
  }).pipe(
    Effect.tapError((cause) =>
      Effect.gen(function* () {
        const coordinator = yield* RecordingCoordinator
        const snapshot = yield* coordinator.snapshot
        yield* Effect.logError("Assistant exited with error").pipe(
          Effect.annotateLogs({
            "assistant.last_mode": snapshot.mode,
            "assistant.last_active": snapshot.active,
            "assistant.last_enabled": snapshot.enabled,
            "assistant.cause": String(cause),
          }),
        )
      }),
    ),
    Effect.provide(coordinatorLayer),
    Effect.provide(Logger.layer([fakeLogger])),
  )

  const result = await Effect.runPromise(Effect.result(failEffect))

  assert.ok(Result.isFailure(result), "expected failure result")

  const errorLogs = logs.filter((l) => l.logLevel === "Error")
  assert.strictEqual(errorLogs.length, 1, `expected 1 error log, got ${errorLogs.length}`)

  const errorLog = errorLogs[0]!
  const message = Array.isArray(errorLog.message) ? errorLog.message[0] : errorLog.message
  assert.strictEqual(message, "Assistant exited with error")
  assert.strictEqual(errorLog.annotations["assistant.last_mode"], "ptt-transcribe")
  assert.strictEqual(errorLog.annotations["assistant.last_active"], true)
  assert.strictEqual(errorLog.annotations["assistant.last_enabled"], true)
  assert.ok(String(errorLog.annotations["assistant.cause"]).includes("synthetic assistant failure"))
})
