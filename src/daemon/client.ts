import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as RpcClient from "effect/unstable/rpc/RpcClient"
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization"
import * as Socket from "effect/unstable/socket/Socket"
import * as NodeSocket from "@effect/platform-node-shared/NodeSocket"

import type { RecordingSnapshot, StartResult } from "../commands/assistant/coordinator.js"
import { DAEMON_SOCKET_PATH } from "../paths.js"
import { DaemonRpc } from "./contract.js"
import { DaemonClientError, classifyRpcClientError } from "./errors.js"

export { DaemonClientError } from "./errors.js"

export class DaemonClient extends Context.Service<
  DaemonClient,
  {
    readonly status: () => Effect.Effect<RecordingSnapshot, DaemonClientError>
    readonly pause: () => Effect.Effect<void, DaemonClientError>
    readonly resume: () => Effect.Effect<void, DaemonClientError>
    readonly toggle: () => Effect.Effect<boolean, DaemonClientError>
    readonly meetingStart: () => Effect.Effect<
      { readonly result: StartResult; readonly snapshot: RecordingSnapshot },
      DaemonClientError
    >
    readonly meetingStop: () => Effect.Effect<RecordingSnapshot, DaemonClientError>
    readonly meetingToggle: () => Effect.Effect<RecordingSnapshot, DaemonClientError>
  }
>()("pie/daemon/DaemonClient") {
  static readonly layer = (options?: {
    readonly socketPath?: string
  }): Layer.Layer<DaemonClient> => {
    const makeFailingClient = (error: DaemonClientError): {
      readonly status: () => Effect.Effect<RecordingSnapshot, DaemonClientError>
      readonly pause: () => Effect.Effect<void, DaemonClientError>
      readonly resume: () => Effect.Effect<void, DaemonClientError>
      readonly toggle: () => Effect.Effect<boolean, DaemonClientError>
      readonly meetingStart: () => Effect.Effect<
        { readonly result: StartResult; readonly snapshot: RecordingSnapshot },
        DaemonClientError
      >
      readonly meetingStop: () => Effect.Effect<RecordingSnapshot, DaemonClientError>
      readonly meetingToggle: () => Effect.Effect<RecordingSnapshot, DaemonClientError>
    } => ({
      status: () => Effect.fail(error),
      pause: () => Effect.fail(error),
      resume: () => Effect.fail(error),
      toggle: () => Effect.fail(error),
      meetingStart: () => Effect.fail(error),
      meetingStop: () => Effect.fail(error),
      meetingToggle: () => Effect.fail(error),
    })
  const socketPath = options?.socketPath ?? DAEMON_SOCKET_PATH

  const workingLayer = Layer.effect(
    DaemonClient,
    Effect.gen(function* () {
      const client = yield* RpcClient.make(DaemonRpc).pipe(
        Effect.provide(RpcClient.layerProtocolSocket()),
        Effect.provide(RpcSerialization.layerNdjson),
        Effect.provide(NodeSocket.layerNet({ path: socketPath })),
      )

      return DaemonClient.of({
        status: () =>
          client.Status(undefined).pipe(
            Effect.mapError(classifyRpcClientError),
          ),
        pause: () =>
          client.Pause(undefined).pipe(
            Effect.mapError(classifyRpcClientError),
          ),
        resume: () =>
          client.Resume(undefined).pipe(
            Effect.mapError(classifyRpcClientError),
          ),
        toggle: () =>
          client.Toggle(undefined).pipe(
            Effect.mapError(classifyRpcClientError),
          ),
        meetingStart: () =>
          client.MeetingStart(undefined).pipe(
            Effect.mapError(classifyRpcClientError),
          ),
        meetingStop: () =>
          client.MeetingStop(undefined).pipe(
            Effect.mapError(classifyRpcClientError),
          ),
        meetingToggle: () =>
          client.MeetingToggle(undefined).pipe(
            Effect.mapError(classifyRpcClientError),
          ),
      })
    }),
  )

    return workingLayer.pipe(
      Layer.catchTag("SocketError", (socketError: Socket.SocketError) => {
        const reason = socketError.reason
        let clientError: DaemonClientError

        if (reason instanceof Socket.SocketOpenError) {
          const code: unknown =
            typeof reason.cause === "object" && reason.cause !== null
              ? Reflect.get(reason.cause, "code")
              : undefined
          if (code === "ENOENT" || code === "ECONNREFUSED") {
            clientError = new DaemonClientError({
              kind: "NotRunning",
              message: "Daemon is not running",
              cause: socketError,
            })
          } else {
            clientError = new DaemonClientError({
              kind: "Transport",
              message: `Socket open failed: ${socketError.message}`,
              cause: socketError,
            })
          }
        } else if (
          reason instanceof Socket.SocketReadError ||
          reason instanceof Socket.SocketWriteError ||
          reason instanceof Socket.SocketCloseError
        ) {
          clientError = new DaemonClientError({
            kind: "Transport",
            message: `Socket transport error: ${socketError.message}`,
            cause: socketError,
          })
        } else {
          clientError = new DaemonClientError({
            kind: "Protocol",
            message: `Socket protocol error: ${socketError.message}`,
            cause: socketError,
          })
        }

        return Layer.succeed(DaemonClient, makeFailingClient(clientError))
      }),
    )
  }
}
