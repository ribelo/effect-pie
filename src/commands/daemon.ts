import { Console, Data, Effect, Ref } from "effect"
import { Command } from "effect/unstable/cli"
import * as http from "node:http"
import { mkdir as mkdirNode, unlink } from "node:fs/promises"

import { EFFECT_PI_RUNTIME_DIR } from "../paths.js"
import { notifyWarning } from "../desktop/notification.js"
import {
  setAssistantRecordingEnabled,
  type AssistantRecordingRuntimeState,
  type AssistantRecordingState,
} from "./assistant/recordingState.js"

export const DAEMON_SOCKET_PATH = `${EFFECT_PI_RUNTIME_DIR}/control.sock`

class DaemonClientError extends Data.TaggedError("DaemonClientError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

const daemonRequest = (options: {
  readonly method: string
  readonly path: string
  readonly body?: string
}): Effect.Effect<string> =>
  Effect.tryPromise({
    try: () =>
      new Promise<string>((resolve, reject) => {
        const req = http.request(
          {
            socketPath: DAEMON_SOCKET_PATH,
            path: options.path,
            method: options.method,
            headers:
              options.body !== undefined
                ? {
                    "Content-Type": "application/json",
                    "Content-Length": String(Buffer.byteLength(options.body)),
                  }
                : {},
          },
          (res) => {
            let data = ""
            res.on("data", (c) => {
              data += c
            })
            res.on("end", () => resolve(data))
          },
        )
        req.on("error", (err) => reject(err))
        if (options.body !== undefined) {
          req.write(options.body)
        }
        req.end()
      }),
    catch: (cause) => new DaemonClientError({ message: String(cause) }),
  }).pipe(Effect.catch(() => Effect.succeed("")))

export const startDaemonServer = (config: {
  readonly ref: Ref.Ref<AssistantRecordingRuntimeState>
}): Effect.Effect<never> =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* Effect.tryPromise({
        try: async () => {
          await mkdirNode(EFFECT_PI_RUNTIME_DIR, { recursive: true })
          await unlink(DAEMON_SOCKET_PATH).catch(() => {})
        },
        catch: () => new DaemonClientError({ message: "daemon setup failed" }),
      }).pipe(Effect.catch(() => Effect.void))

      const server = Bun.serve({
        unix: DAEMON_SOCKET_PATH,
        async fetch(req) {
          const url = new URL(req.url)
          const method = req.method
          const pathname = url.pathname

          if (method === "GET" && pathname === "/state") {
            const runtime = await Effect.runPromise(Ref.get(config.ref))
            const state: AssistantRecordingState = {
              enabled: runtime.enabled,
              active: runtime.mode !== undefined,
              mode: runtime.mode ?? "idle",
              startedAt:
                runtime.startedAtMs !== undefined
                  ? new Date(runtime.startedAtMs).toISOString()
                  : null,
              updatedAt: new Date().toISOString(),
            }
            return new Response(JSON.stringify(state), {
              headers: { "Content-Type": "application/json" },
            })
          }

          if (method === "POST" && pathname === "/pause") {
            await Effect.runPromise(
              setAssistantRecordingEnabled({
                ref: config.ref,
                enabled: false,
              }),
            )
            return new Response(JSON.stringify({ enabled: false }))
          }

          if (method === "POST" && pathname === "/resume") {
            await Effect.runPromise(
              setAssistantRecordingEnabled({
                ref: config.ref,
                enabled: true,
              }),
            )
            return new Response(JSON.stringify({ enabled: true }))
          }

          if (method === "POST" && pathname === "/toggle") {
            const current = await Effect.runPromise(Ref.get(config.ref))
            const next = !current.enabled
            await Effect.runPromise(
              setAssistantRecordingEnabled({
                ref: config.ref,
                enabled: next,
              }),
            )
            return new Response(JSON.stringify({ enabled: next }))
          }

          return new Response("Not Found", { status: 404 })
        },
      })

      yield* Effect.addFinalizer(() =>
        Effect.promise(() => Promise.resolve(server.stop(true))).pipe(Effect.ignore),
      )

      yield* Console.log(`[daemon] Listening on ${DAEMON_SOCKET_PATH}`)
      return yield* Effect.never
    }),
  )

export const statusCommand = Command.make("status", {}, () =>
  Effect.gen(function* () {
    const response = yield* daemonRequest({
      method: "GET",
      path: "/state",
    })

    if (response === "") {
      yield* Console.log("off")
      return
    }

    const parsed: unknown = JSON.parse(response)
    if (typeof parsed !== "object" || parsed === null) {
      yield* Console.log("stale")
      return
    }

    if (
      typeof Reflect.get(parsed, "enabled") !== "boolean" ||
      typeof Reflect.get(parsed, "active") !== "boolean" ||
      typeof Reflect.get(parsed, "mode") !== "string"
    ) {
      yield* Console.log("stale")
      return
    }

    if (Reflect.get(parsed, "enabled") === false) {
      yield* Console.log("paused")
      return
    }

    if (Reflect.get(parsed, "active") === false) {
      yield* Console.log("armed")
      return
    }

    const mode = String(Reflect.get(parsed, "mode"))
    if (mode === "wakeword" || mode === "ptt-transcribe" || mode === "ptt-translate") {
      yield* Console.log(mode)
      return
    }

    yield* Console.log("stale")
  }),
)

export const toggleCommand = Command.make("toggle", {}, () =>
  Effect.gen(function* () {
    const response = yield* daemonRequest({
      method: "POST",
      path: "/toggle",
    })

    if (response === "") {
      yield* notifyWarning("PIE", "PIE is not running").pipe(Effect.ignore)
      yield* Console.log("off")
      return
    }

    const parsed2: unknown = JSON.parse(response)
    if (typeof parsed2 !== "object" || parsed2 === null) {
      yield* Console.log("stale")
      return
    }

    if (typeof Reflect.get(parsed2, "enabled") !== "boolean") {
      yield* Console.log("stale")
      return
    }

    yield* Console.log(Reflect.get(parsed2, "enabled") === true ? "armed" : "paused")
  }),
)

export const pauseCommand = Command.make("pause", {}, () =>
  Effect.gen(function* () {
    yield* daemonRequest({ method: "POST", path: "/pause" })
  }),
)

export const resumeCommand = Command.make("resume", {}, () =>
  Effect.gen(function* () {
    yield* daemonRequest({ method: "POST", path: "/resume" })
  }),
)
