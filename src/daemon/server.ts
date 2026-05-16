import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as RpcServer from "effect/unstable/rpc/RpcServer"
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization"
import * as BunSocketServer from "@effect/platform-bun/BunSocketServer"
import { mkdir as mkdirNode, unlink } from "node:fs/promises"

import * as path from "node:path"

import { RecordingCoordinator } from "../commands/assistant/coordinator.js"
import { MeetingTranscriptionController } from "../commands/assistant/meetingTranscription.js"
import { DAEMON_SOCKET_PATH } from "../paths.js"
import { DaemonRpc } from "./contract.js"
import { SocketPreflightError } from "./errors.js"

export const DaemonRpcServer = {
  layer: (options?: {
    readonly socketPath?: string
  }): Layer.Layer<
    never,
    SocketPreflightError,
    RecordingCoordinator | MeetingTranscriptionController
  > => {
    const socketPath = options?.socketPath ?? DAEMON_SOCKET_PATH

    return Layer.effectDiscard(
      Effect.gen(function* () {
        const coordinator = yield* RecordingCoordinator
        const meeting = yield* MeetingTranscriptionController

        yield* Effect.tryPromise({
          try: async () => {
            await mkdirNode(path.dirname(socketPath), { recursive: true })
            await unlink(socketPath).catch((err: unknown) => {
              if (
                typeof err === "object" &&
                err !== null &&
                "code" in err &&
                (err as { code: unknown }).code === "ENOENT"
              ) {
                return
              }
              throw err
            })
          },
          catch: (cause) =>
            new SocketPreflightError({
              message: `Daemon socket preflight failed at ${socketPath}`,
              cause,
            }),
        })

        const handlers = {
          Status: () => coordinator.snapshot,
          Pause: () => coordinator.setEnabled(false),
          Resume: () => coordinator.setEnabled(true),
          Toggle: () => coordinator.toggleEnabled,
          MeetingStart: () => meeting.start,
          MeetingStop: () => meeting.stop,
          MeetingToggle: () => meeting.toggle,
        }

        const protocolLayer = RpcServer.layerProtocolSocketServer.pipe(
          Layer.provide(RpcSerialization.layerNdjson),
          Layer.provide(BunSocketServer.layer({ path: socketPath }).pipe(Layer.orDie)),
        )

        const serverLayer = DaemonRpc.toLayer(handlers).pipe(Layer.provideMerge(protocolLayer))

        const ctx = yield* Layer.build(serverLayer)
        yield* RpcServer.make(DaemonRpc).pipe(Effect.provideContext(ctx), Effect.forkScoped)

        yield* Effect.addFinalizer(() =>
          Effect.promise(() =>
            unlink(socketPath).catch((err: unknown) => {
              if (
                typeof err === "object" &&
                err !== null &&
                "code" in err &&
                (err as { code: unknown }).code === "ENOENT"
              ) {
                return
              }
              throw err
            }),
          ),
        )
      }),
    )
  },
}
