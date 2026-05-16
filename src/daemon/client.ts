import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as net from "node:net"

import {
  RecordingSnapshotSchema,
  StartResultSchema,
  type RecordingSnapshot,
} from "../commands/assistant/coordinator.js"
import { DAEMON_SOCKET_PATH } from "../paths.js"
import { isRecord } from "../utils/isRecord.js"
import { DaemonClientError } from "./errors.js"

export { DaemonClientError } from "./errors.js"

const MeetingStartResponseSchema = Schema.Struct({
  result: StartResultSchema,
  snapshot: RecordingSnapshotSchema,
})

type MeetingStartResponse = typeof MeetingStartResponseSchema.Type

const rawRequest = (socketPath: string, tag: string): Effect.Effect<unknown, DaemonClientError> =>
  Effect.tryPromise({
    try: () =>
      new Promise<unknown>((resolve, reject) => {
        const client = net.createConnection(socketPath)
        let settled = false
        let buffer = ""

        const finish = (result: unknown, failed: boolean) => {
          if (settled) return
          settled = true
          client.destroy()
          if (failed) {
            reject(result)
          } else {
            resolve(result)
          }
        }

        client.setEncoding("utf8")
        client.setTimeout(2_000)
        client.on("connect", () => {
          client.write(
            `${JSON.stringify({
              _tag: "Request",
              tag,
              id: "1",
              payload: null,
              headers: [],
            })}\n`,
          )
        })
        client.on("data", (chunk) => {
          buffer += chunk
          const newlineIndex = buffer.indexOf("\n")
          if (newlineIndex === -1) return

          const line = buffer.slice(0, newlineIndex).trim()
          if (line.length === 0) return

          try {
            finish(JSON.parse(line), false)
          } catch (cause) {
            finish(
              new DaemonClientError({
                kind: "Protocol",
                message: "Daemon returned malformed JSON",
                cause,
              }),
              true,
            )
          }
        })
        client.on("timeout", () => {
          finish(
            new DaemonClientError({
              kind: "NotRunning",
              message: "Daemon is not running",
            }),
            true,
          )
        })
        client.on("error", (cause: NodeJS.ErrnoException) => {
          finish(
            new DaemonClientError({
              kind:
                cause.code === "ENOENT" || cause.code === "ECONNREFUSED"
                  ? "NotRunning"
                  : "Transport",
              message:
                cause.code === "ENOENT" || cause.code === "ECONNREFUSED"
                  ? "Daemon is not running"
                  : `Socket transport error: ${cause.message}`,
              cause,
            }),
            true,
          )
        })
        client.on("end", () => {
          finish(
            new DaemonClientError({
              kind: "Transport",
              message: "Daemon socket closed before a response was received",
            }),
            true,
          )
        })
      }),
    catch: (cause) =>
      cause instanceof DaemonClientError
        ? cause
        : new DaemonClientError({
            kind: "Transport",
            message: "Daemon socket request failed",
            cause,
          }),
  })

const decodeResponse = <S extends Schema.Top>(schema: S, value: unknown) =>
  Effect.gen(function* () {
    if (!isRecord(value)) {
      return yield* new DaemonClientError({
        kind: "Protocol",
        message: "Daemon response was not an object",
      })
    }

    const exit = value["exit"]
    if (!isRecord(exit)) {
      return yield* new DaemonClientError({
        kind: "Protocol",
        message: "Daemon response missing exit object",
      })
    }

    if (exit["_tag"] !== "Success") {
      return yield* new DaemonClientError({
        kind: "Protocol",
        message: "Daemon returned an unsuccessful RPC exit",
        cause: value,
      })
    }

    return yield* Schema.decodeUnknownEffect(schema)(exit["value"]).pipe(
      Effect.mapError(
        (cause) =>
          new DaemonClientError({
            kind: "Protocol",
            message: "Daemon response did not match the expected schema",
            cause,
          }),
      ),
    )
  })

const request = <S extends Schema.Top>(socketPath: string, tag: string, schema: S) =>
  rawRequest(socketPath, tag).pipe(Effect.andThen((value) => decodeResponse(schema, value)))

export class DaemonClient extends Context.Service<
  DaemonClient,
  {
    readonly status: () => Effect.Effect<RecordingSnapshot, DaemonClientError>
    readonly pause: () => Effect.Effect<void, DaemonClientError>
    readonly resume: () => Effect.Effect<void, DaemonClientError>
    readonly toggle: () => Effect.Effect<boolean, DaemonClientError>
    readonly meetingStart: () => Effect.Effect<MeetingStartResponse, DaemonClientError>
    readonly meetingStop: () => Effect.Effect<RecordingSnapshot, DaemonClientError>
    readonly meetingToggle: () => Effect.Effect<RecordingSnapshot, DaemonClientError>
  }
>()("pie/daemon/DaemonClient") {
  static readonly layer = (options?: {
    readonly socketPath?: string
  }): Layer.Layer<DaemonClient> => {
    const socketPath = options?.socketPath ?? DAEMON_SOCKET_PATH

    return Layer.succeed(
      DaemonClient,
      DaemonClient.of({
        status: () => request(socketPath, "Status", RecordingSnapshotSchema),
        pause: () => request(socketPath, "Pause", Schema.Void),
        resume: () => request(socketPath, "Resume", Schema.Void),
        toggle: () => request(socketPath, "Toggle", Schema.Boolean),
        meetingStart: () => request(socketPath, "MeetingStart", MeetingStartResponseSchema),
        meetingStop: () => request(socketPath, "MeetingStop", RecordingSnapshotSchema),
        meetingToggle: () => request(socketPath, "MeetingToggle", RecordingSnapshotSchema),
      }),
    )
  }
}
