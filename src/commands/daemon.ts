import { Console, Effect } from "effect"
import { Command } from "effect/unstable/cli"

import { notifyWarning } from "../desktop/notification.js"
import { DaemonClient } from "../daemon/client.js"
import type { DaemonClientError } from "../daemon/errors.js"

const renderClientError = (e: DaemonClientError): Effect.Effect<void> =>
  Effect.gen(function* () {
    switch (e.kind) {
      case "NotRunning": {
        yield* Console.log("off")
        return
      }
      case "Transport": {
        yield* Console.error(`pie: daemon transport error: ${e.message}`)
        return yield* Effect.sync(() => process.exit(1))
      }
      case "Protocol": {
        yield* Console.error(`pie: daemon protocol error: ${e.message}`)
        return yield* Effect.sync(() => process.exit(1))
      }
    }
  })

export const statusCommand = Command.make("status", {}, () =>
  Effect.gen(function* () {
    const client = yield* DaemonClient
    yield* client.status().pipe(
      Effect.matchEffect({
        onFailure: renderClientError,
        onSuccess: (snapshot) => {
          if (!snapshot.enabled) {
            return Console.log("paused")
          }
          if (!snapshot.active) {
            return Console.log("armed")
          }
          return Console.log(snapshot.mode === "idle" ? "stale" : snapshot.mode)
        },
      }),
    )
  }).pipe(Effect.provide(DaemonClient.layer())),
)

export const toggleCommand = Command.make("toggle", {}, () =>
  Effect.gen(function* () {
    const client = yield* DaemonClient
    yield* client.toggle().pipe(
      Effect.matchEffect({
        onFailure: (e) =>
          e.kind === "NotRunning"
            ? Effect.gen(function* () {
                yield* notifyWarning("PIE", "PIE is not running").pipe(Effect.ignore)
                yield* Console.log("off")
              })
            : renderClientError(e),
        onSuccess: (nextEnabled) => Console.log(nextEnabled ? "armed" : "paused"),
      }),
    )
  }).pipe(Effect.provide(DaemonClient.layer())),
)

export const pauseCommand = Command.make("pause", {}, () =>
  Effect.gen(function* () {
    const client = yield* DaemonClient
    yield* client.pause().pipe(Effect.catch(renderClientError))
  }).pipe(Effect.provide(DaemonClient.layer())),
)

export const resumeCommand = Command.make("resume", {}, () =>
  Effect.gen(function* () {
    const client = yield* DaemonClient
    yield* client.resume().pipe(Effect.catch(renderClientError))
  }).pipe(Effect.provide(DaemonClient.layer())),
)

export const meetingStartCommand = Command.make("meeting-start", {}, () =>
  Effect.gen(function* () {
    const client = yield* DaemonClient
    yield* client.meetingStart().pipe(
      Effect.matchEffect({
        onFailure: renderClientError,
        onSuccess: ({ result, snapshot }) => {
          if (Reflect.get(result, "_tag") === "Busy") {
            return Console.log(`busy:${result.activeMode}`)
          }
          if (Reflect.get(result, "_tag") === "Disabled") {
            return Console.log("paused")
          }
          return Console.log(snapshot.mode)
        },
      }),
    )
  }).pipe(Effect.provide(DaemonClient.layer())),
).pipe(Command.withDescription("Start meeting transcription"))

export const meetingStopCommand = Command.make("meeting-stop", {}, () =>
  Effect.gen(function* () {
    const client = yield* DaemonClient
    yield* client.meetingStop().pipe(
      Effect.matchEffect({
        onFailure: renderClientError,
        onSuccess: (snapshot) =>
          Console.log(snapshot.mode === "idle" ? "armed" : snapshot.mode),
      }),
    )
  }).pipe(Effect.provide(DaemonClient.layer())),
).pipe(Command.withDescription("Stop meeting transcription"))

export const meetingToggleCommand = Command.make("meeting-toggle", {}, () =>
  Effect.gen(function* () {
    const client = yield* DaemonClient
    yield* client.meetingToggle().pipe(
      Effect.matchEffect({
        onFailure: renderClientError,
        onSuccess: (snapshot) =>
          Console.log(snapshot.mode === "idle" ? "armed" : snapshot.mode),
      }),
    )
  }).pipe(Effect.provide(DaemonClient.layer())),
).pipe(Command.withDescription("Toggle meeting transcription"))
