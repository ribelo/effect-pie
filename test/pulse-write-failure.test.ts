import { test } from "node:test"
import * as assert from "node:assert/strict"
import * as Effect from "effect/Effect"
import * as Scope from "effect/Scope"
import type * as Socket from "effect/unstable/socket/Socket"

import { awaitReply, PulseAudioClientError } from "../src/pulse/client.ts"

const makeMockConnection = (
  writer: (
    chunk: Uint8Array | string | Socket.CloseEvent,
  ) => Effect.Effect<void, Socket.SocketError>,
) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make()
    return {
      scope,
      writer,
      pending: new Map(),
      recordQueues: new Map(),
      socketPath: "/fake",
      requestTimeoutMs: 100,
      protocolVersion: 0,
      remainder: new Uint8Array(),
    }
  })

test("awaitReply propagates PulseAudioClientError when writer fails", async () => {
  const program = Effect.gen(function* () {
    const failingWriter = (_chunk: Uint8Array | string | Socket.CloseEvent) =>
      Effect.fail({} as Socket.SocketError)

    const connection = yield* makeMockConnection(failingWriter)
    const packet = { tag: 1, bytes: new Uint8Array([0]) }

    const error = yield* awaitReply(connection, packet).pipe(Effect.flip)

    assert.ok(
      error instanceof PulseAudioClientError,
      `expected PulseAudioClientError, got ${error?.constructor?.name}`,
    )
    assert.equal(error.message, "failed to send command to PulseAudio")
  })

  await Effect.runPromise(program)
})
