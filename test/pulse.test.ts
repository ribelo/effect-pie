import { test } from "node:test"
import * as assert from "node:assert/strict"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Ref from "effect/Ref"
import * as Stream from "effect/Stream"
import * as Data from "effect/Data"
import { promises as fs } from "node:fs"

import { PA_DEFAULT_SOCKET_PATH } from "../src/pulse/defs.ts"
import { PulseAudioClient } from "../src/pulse/client.ts"
import { createRecordStream } from "../src/pulse/stream.ts"

class PulseTestTimeoutError extends Data.TaggedError("PulseTestTimeoutError")<{
  readonly message: string
}> {}

const hasPulseSocket = async (): Promise<boolean> => {
  try {
    await fs.access(PA_DEFAULT_SOCKET_PATH)
    return true
  } catch {
    return false
  }
}

test("connects to PulseAudio and records audio", { timeout: 30_000 }, async () => {
  if (!(await hasPulseSocket())) {
    return
  }

  const program = Effect.gen(function* () {
    const client = yield* PulseAudioClient

    const serverInfo = yield* client.getServerInfo
    assert.ok(serverInfo.name !== null && serverInfo.name.length > 0)

    const sources = yield* client.listSources
    assert.ok(sources.length > 0)

    const byteCountRef = yield* Ref.make(0)

    const recorderFiber = yield* createRecordStream({ fragmentSize: 1024 }).pipe(
      Stream.runForEach((chunk) => Ref.update(byteCountRef, (current) => current + chunk.length)),
      Effect.forkDetach,
    )

    yield* Effect.sleep("1 second")
    yield* Fiber.interrupt(recorderFiber)

    const byteCount = yield* Ref.get(byteCountRef)
    assert.ok(byteCount > 0)
  }).pipe(
    Effect.timeoutOrElse({
      duration: "20 seconds",
      orElse: () =>
        Effect.fail(
          new PulseTestTimeoutError({ message: "PulseAudio integration test timed out" }),
        ),
    }),
    Effect.provide(PulseAudioClient.layer()),
  )

  await Effect.runPromise(program)
})
