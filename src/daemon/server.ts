import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as RpcServer from "effect/unstable/rpc/RpcServer"
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization"
import * as BunSocketServer from "@effect/platform-bun/BunSocketServer"
import { mkdir as mkdirNode, unlink } from "node:fs/promises"

import * as path from "node:path"

import { RecordingCoordinator } from "../commands/assistant/coordinator.js"
import { DAEMON_SOCKET_PATH } from "../paths.js"
import { DaemonRpc } from "./contract.js"

export const DaemonRpcServer = {
  layer: (options?: { readonly socketPath?: string }): Layer.Layer<never> => {
    const socketPath = options?.socketPath ?? DAEMON_SOCKET_PATH

    return Layer.effectDiscard(
      Effect.gen(function* () {
        const coordinator = yield* RecordingCoordinator

        yield* Effect.tryPromise({
          try: async () => {
            await mkdirNode(path.dirname(socketPath), { recursive: true })
            await unlink(socketPath).catch(() => {})
          },
          catch: (cause) => new Error(String(cause)),
        }).pipe(Effect.catch(() => Effect.void))

        const handlers = {
          Status: () => coordinator.snapshot,
          Pause: () => coordinator.setEnabled(false),
          Resume: () => coordinator.setEnabled(true),
          Toggle: () => coordinator.toggleEnabled,
          MeetingStart: () =>
            Effect.gen(function* () {
              const result = yield* coordinator.tryStart("meeting-transcribe")
              const snapshot = yield* coordinator.snapshot
              return { result, snapshot }
            }),
          MeetingStop: () =>
            coordinator.stop("meeting-transcribe").pipe(
              Effect.andThen(coordinator.snapshot),
            ),
          MeetingToggle: () => coordinator.toggleMeeting,
        }

        const protocolLayer = RpcServer.layerProtocolSocketServer.pipe(
          Layer.provide(RpcSerialization.layerNdjson),
          Layer.provide(
            BunSocketServer.layer({ path: socketPath }).pipe(Layer.orDie),
          ),
        )

        const serverLayer = DaemonRpc.toLayer(handlers).pipe(
          Layer.provideMerge(protocolLayer),
        )

        const ctx = yield* Layer.build(serverLayer)
        yield* RpcServer.make(DaemonRpc).pipe(
          Effect.provideContext(ctx),
          Effect.forkScoped,
        )
      }),
    )
  },
}
