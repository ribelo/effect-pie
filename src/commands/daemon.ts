import { Console, Data, Effect, Ref } from "effect"
import { Command } from "effect/unstable/cli"
import * as http from "node:http"
import { mkdir as mkdirNode, unlink } from "node:fs/promises"

import { EFFECT_PI_RUNTIME_DIR } from "../paths.js"
import { notifyWarning } from "../desktop/notification.js"
import { isRecord } from "../utils/isRecord.js"
import {
  setRecordingEnabled,
  tryStartRecording,
  stopRecording,
  getRecordingState,
  type RecordingRuntimeState,
  type RecordingMode,
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
  readonly ref: Ref.Ref<RecordingRuntimeState>
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
            const state = await Effect.runPromise(getRecordingState({ ref: config.ref }))
            return new Response(JSON.stringify(state), {
              headers: { "Content-Type": "application/json" },
            })
          }

          if (method === "POST" && pathname === "/pause") {
            await Effect.runPromise(
              setRecordingEnabled({
                ref: config.ref,
                enabled: false,
              }),
            )
            return new Response(JSON.stringify({ enabled: false }))
          }

          if (method === "POST" && pathname === "/resume") {
            await Effect.runPromise(
              setRecordingEnabled({
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
              setRecordingEnabled({
                ref: config.ref,
                enabled: next,
              }),
            )
            return new Response(JSON.stringify({ enabled: next }))
          }

          if (method === "POST" && pathname === "/meeting/start") {
            const result = await Effect.runPromise(
              tryStartRecording({
                ref: config.ref,
                mode: "meeting-transcribe",
              }),
            )
            const state = await Effect.runPromise(getRecordingState({ ref: config.ref }))
            return new Response(JSON.stringify({ result, state }))
          }

          if (method === "POST" && pathname === "/meeting/stop") {
            await Effect.runPromise(
              stopRecording({
                ref: config.ref,
                mode: "meeting-transcribe",
              }),
            )
            const state = await Effect.runPromise(getRecordingState({ ref: config.ref }))
            return new Response(JSON.stringify({ state }))
          }

          if (method === "POST" && pathname === "/meeting/toggle") {
            const current = await Effect.runPromise(Ref.get(config.ref))
            if (current.mode === "meeting-transcribe") {
              await Effect.runPromise(
                stopRecording({
                  ref: config.ref,
                  mode: "meeting-transcribe",
                }),
              )
            } else if (current.mode === undefined) {
              await Effect.runPromise(
                tryStartRecording({
                  ref: config.ref,
                  mode: "meeting-transcribe",
                }),
              )
            }
            const state = await Effect.runPromise(getRecordingState({ ref: config.ref }))
            return new Response(JSON.stringify({ state }))
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

const isValidMode = (mode: string): mode is RecordingMode | "idle" =>
  mode === "ptt-transcribe" ||
  mode === "ptt-translate" ||
  mode === "wakeword" ||
  mode === "meeting-transcribe" ||
  mode === "idle"

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

    const pr = isRecord(parsed) ? parsed : null
    if (
      pr === null ||
      typeof pr["enabled"] !== "boolean" ||
      typeof pr["active"] !== "boolean" ||
      typeof pr["mode"] !== "string"
    ) {
      yield* Console.log("stale")
      return
    }

    if (!pr["enabled"]) {
      yield* Console.log("paused")
      return
    }

    if (!pr["active"]) {
      yield* Console.log("armed")
      return
    }

    const mode = pr["mode"]
    if (isValidMode(mode) && mode !== "idle") {
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

    const p2 = isRecord(parsed2) ? parsed2 : null
    if (p2 === null || typeof p2["enabled"] !== "boolean") {
      yield* Console.log("stale")
      return
    }

    yield* Console.log(p2["enabled"] ? "armed" : "paused")
  }),
)

export const pauseCommand = Command.make("pause", {}, () =>
  daemonRequest({ method: "POST", path: "/pause" }),
)

export const resumeCommand = Command.make("resume", {}, () =>
  daemonRequest({ method: "POST", path: "/resume" }),
)

export const meetingStartCommand = Command.make("meeting-start", {}, () =>
  Effect.gen(function* () {
    const response = yield* daemonRequest({ method: "POST", path: "/meeting/start" })
    if (response === "") {
      yield* Console.log("off")
      return
    }
    const parsed: unknown = JSON.parse(response)
    if (typeof parsed !== "object" || parsed === null) {
      yield* Console.log("stale")
      return
    }
    const pStart = isRecord(parsed) ? parsed : null
    if (pStart !== null) {
      const rawResult = pStart["result"]
      const result = isRecord(rawResult) ? rawResult : null
      if (result !== null) {
        if (result["_tag"] === "Busy") {
          yield* Console.log(`busy:${String(result["activeMode"])}`)
          return
        }
        if (result["_tag"] === "Disabled") {
          yield* Console.log("paused")
          return
        }
      }
      const rawState = pStart["state"]
      const state = isRecord(rawState) ? rawState : null
      if (state !== null && typeof state["mode"] === "string") {
        yield* Console.log(state["mode"])
        return
      }
    }
    yield* Console.log("stale")
  }),
).pipe(Command.withDescription("Start meeting transcription"))

export const meetingStopCommand = Command.make("meeting-stop", {}, () =>
  Effect.gen(function* () {
    const response = yield* daemonRequest({ method: "POST", path: "/meeting/stop" })
    if (response === "") {
      yield* Console.log("off")
      return
    }
    const parsed: unknown = JSON.parse(response)
    if (typeof parsed !== "object" || parsed === null) {
      yield* Console.log("stale")
      return
    }
    const pStop = isRecord(parsed) ? parsed : null
    if (pStop !== null) {
      const rawState = pStop["state"]
      const state = isRecord(rawState) ? rawState : null
      if (state !== null && typeof state["mode"] === "string") {
        const mode = state["mode"]
        yield* Console.log(mode === "idle" ? "armed" : mode)
        return
      }
    }
    yield* Console.log("stale")
  }),
).pipe(Command.withDescription("Stop meeting transcription"))

export const meetingToggleCommand = Command.make("meeting-toggle", {}, () =>
  Effect.gen(function* () {
    const response = yield* daemonRequest({ method: "POST", path: "/meeting/toggle" })
    if (response === "") {
      yield* Console.log("off")
      return
    }
    const parsed: unknown = JSON.parse(response)
    if (typeof parsed !== "object" || parsed === null) {
      yield* Console.log("stale")
      return
    }
    const pToggle = isRecord(parsed) ? parsed : null
    if (pToggle !== null) {
      const rawState = pToggle["state"]
      const state = isRecord(rawState) ? rawState : null
      if (state !== null && typeof state["mode"] === "string") {
        const mode = state["mode"]
        yield* Console.log(mode === "idle" ? "armed" : mode)
        return
      }
    }
    yield* Console.log("stale")
  }),
).pipe(Command.withDescription("Toggle meeting transcription"))
