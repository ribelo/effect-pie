import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as RpcServer from "effect/unstable/rpc/RpcServer"
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization"
import * as BunSocketServer from "@effect/platform-bun/BunSocketServer"
import { mkdir as mkdirNode, unlink } from "node:fs/promises"

import { RecordingCoordinator } from "../commands/assistant/coordinator.js"
import { EFFECT_PI_RUNTIME_DIR } from "../paths.js"
import { DaemonRpc } from "./contract.js"

export const DAEMON_SOCKET_PATH = `${EFFECT_PI_RUNTIME_DIR}/control.sock`

export const DaemonRpcServer = {
  layer: Layer.effectDiscard(
    Effect.gen(function* () {
      const coordinator = yield* RecordingCoordinator

      yield* Effect.tryPromise({
        try: async () => {
          await mkdirNode(EFFECT_PI_RUNTIME_DIR, { recursive: true })
          await unlink(DAEMON_SOCKET_PATH).catch(() => {})
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

      const serverLayer = DaemonRpc.toLayer(handlers).pipe(
        Layer.provide(RpcServer.layerProtocolSocketServer),
        Layer.provide(RpcSerialization.layerNdjson),
        Layer.provide(
          BunSocketServer.layer({ path: DAEMON_SOCKET_PATH }).pipe(Layer.orDie),
        ),
      )

      const ctx = yield* Layer.build(serverLayer)
      return yield* RpcServer.make(DaemonRpc).pipe(Effect.provideContext(ctx))
    }),
  ),
}
