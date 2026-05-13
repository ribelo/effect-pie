import { test } from "node:test"
import * as assert from "node:assert/strict"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"

import { NiriIpcError, NiriTimeoutError } from "../src/niri/errors.js"
import {
  findNiriExecutable,
  runNiriCommand,
  streamNiriCommandLines,
  Niri,
} from "../src/niri/niri.js"
import type { CommandRunner } from "../src/niri/niri.js"

const makeTestRunner = (handlers: {
  readonly run?: (argv: ReadonlyArray<string>, timeoutMs: number) => string
  readonly streamLines?: Stream.Stream<string>
}): CommandRunner => ({
  run: (argv, _timeoutMs) =>
    Effect.sync(() => {
      if (handlers.run) {
        return handlers.run(argv, _timeoutMs)
      }
      return "null"
    }),
  streamLines: () => handlers.streamLines ?? Stream.empty,
})

test("Niri read APIs decode successful payloads and null focused-window absence", async () => {
  const runner = makeTestRunner({
    run: (argv) => {
      const request = argv[argv.length - 1]
      if (request === "version") return JSON.stringify({ cli: "25.11", compositor: "25.11" })
      if (request === "focused-window") return "null"
      if (request === "overview-state") return JSON.stringify({ is_open: false })
      return "[]"
    },
  })

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const niri = yield* Niri
      const version = yield* niri.version
      const focusedWindow = yield* niri.focusedWindow
      const overview = yield* niri.overviewState
      return { version, focusedWindow, overview }
    }).pipe(Effect.provide(Niri.live({ runner }))),
  )

  assert.deepStrictEqual(result.version, { cli: "25.11", compositor: "25.11" })
  assert.strictEqual(result.focusedWindow, null)
  assert.deepStrictEqual(result.overview, { is_open: false })
})

test("Niri read APIs cover all local single-shot JSON requests", async () => {
  const windowPayload = {
    id: 1,
    title: "Terminal",
    app_id: "Alacritty",
    pid: 123,
    workspace_id: 2,
    is_focused: true,
    is_floating: false,
    is_urgent: false,
    layout: {
      pos_in_scrolling_layout: [1, 1],
      tile_size: [800, 600],
      window_size: [796, 596],
      tile_pos_in_workspace_view: null,
      window_offset_in_tile: [2, 2],
    },
    focus_timestamp: null,
  }
  const outputPayload = {
    name: "DP-1",
    make: "PNP",
    model: "Panel",
    serial: null,
    physical_size: null,
    modes: [],
    current_mode: null,
    is_custom_mode: false,
    vrr_supported: false,
    vrr_enabled: false,
    logical: null,
  }
  const payloads: Record<string, unknown> = {
    version: { cli: "25.11", compositor: "25.11" },
    outputs: { "DP-1": outputPayload },
    workspaces: [
      {
        id: 2,
        idx: 1,
        name: null,
        output: "DP-1",
        is_urgent: false,
        is_active: true,
        is_focused: true,
        active_window_id: 1,
      },
    ],
    windows: [windowPayload],
    layers: [
      {
        namespace: "bar",
        output: "DP-1",
        layer: "Top",
        keyboard_interactivity: "None",
      },
    ],
    "keyboard-layouts": { names: ["Polish"], current_idx: 0 },
    "focused-output": outputPayload,
    "focused-window": windowPayload,
    "pick-window": windowPayload,
    "pick-color": { rgb: [0.1, 0.2, 0.3] },
    "overview-state": { is_open: false },
  }

  const runner = makeTestRunner({
    run: (argv) => {
      const request = argv[argv.length - 1]!
      return JSON.stringify(payloads[request] ?? [])
    },
  })

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const niri = yield* Niri
      return {
        version: yield* niri.version,
        outputs: yield* niri.outputs,
        workspaces: yield* niri.workspaces,
        windows: yield* niri.windows,
        layers: yield* niri.layers,
        keyboardLayouts: yield* niri.keyboardLayouts,
        focusedOutput: yield* niri.focusedOutput,
        focusedWindow: yield* niri.focusedWindow,
        pickWindow: yield* niri.pickWindow,
        pickColor: yield* niri.pickColor,
        overviewState: yield* niri.overviewState,
      }
    }).pipe(Effect.provide(Niri.live({ runner }))),
  )

  const dp1 = result.outputs["DP-1"]
  assert.ok(dp1)
  assert.strictEqual(dp1["name"], "DP-1")
  assert.strictEqual(result.workspaces[0]?.["id"], 2)
  assert.strictEqual(result.windows[0]?.["id"], 1)
  assert.strictEqual(result.layers[0]?.["namespace"], "bar")
  assert.strictEqual(result.keyboardLayouts.names[0], "Polish")
  assert.strictEqual(result.focusedOutput?.["name"], "DP-1")
  assert.strictEqual(result.focusedWindow?.["id"], 1)
  assert.strictEqual(result.pickWindow?.["id"], 1)
  assert.deepStrictEqual(result.pickColor?.["rgb"], [0.1, 0.2, 0.3])
  assert.strictEqual(result.overviewState["is_open"], false)
})

test("Niri read APIs fail with typed decode errors for wrong payload shape", async () => {
  const runner = makeTestRunner({
    run: () => JSON.stringify({ compositor: 42 }),
  })

  const error = await Effect.runPromise(
    Effect.flip(
      Effect.gen(function* () {
        const niri = yield* Niri
        return yield* niri.version
      }).pipe(Effect.provide(Niri.live({ runner }))),
    ),
  )

  assert.strictEqual(Reflect.get(error, "_tag"), "NiriDecodeError")
})

test("Niri action and output APIs delegate typed commands to the runner", async () => {
  const calls: Array<unknown> = []

  const runner = makeTestRunner({
    run: (argv) => {
      calls.push(argv)
      return JSON.stringify("Applied")
    },
  })

  await Effect.runPromise(
    Effect.gen(function* () {
      const niri = yield* Niri
      yield* niri.actions.focusWindow(7)
      yield* niri.actions.moveWindowToWorkspace(
        { type: "index", index: 3 },
        { windowId: 8, focus: false },
      )
      const outputResult = yield* niri.outputsConfig.setScale("DP-1", 2)
      yield* niri.outputsConfig.setCustomMode("DP-1", { width: 1920, height: 1080, refresh: 60 })
      yield* niri.outputsConfig.setPosition("DP-1", { type: "set", x: 10, y: 20 })
      yield* niri.outputsConfig.setVrr("DP-1", { enabled: true, onDemand: true })
      return outputResult
    }).pipe(Effect.provide(Niri.live({ runner }))),
  )

  assert.deepStrictEqual(calls, [
    ["", "msg", "action", "focus-window", "--id", "7"],
    ["", "msg", "action", "move-window-to-workspace", "--window-id", "8", "--focus", "false", "3"],
    ["", "msg", "--json", "output", "DP-1", "scale", "2"],
    ["", "msg", "--json", "output", "DP-1", "custom-mode", "1920x1080@60"],
    ["", "msg", "--json", "output", "DP-1", "position", "set", "10", "20"],
    ["", "msg", "--json", "output", "DP-1", "vrr", "--on-demand", "true"],
  ])
})

test("Niri event stream decodes lines and runs stream finalizers", async () => {
  let finalized = false

  const runner = makeTestRunner({
    streamLines: Stream.fromIterable([
      JSON.stringify({ WindowFocusChanged: { id: 7 } }),
      JSON.stringify({ ConfigLoaded: { failed: false } }),
    ]).pipe(
      Stream.ensuring(
        Effect.sync(() => {
          finalized = true
        }),
      ),
    ),
  })

  const events = await Effect.runPromise(
    Effect.gen(function* () {
      const niri = yield* Niri
      return yield* niri.events.pipe(Stream.take(1), Stream.runCollect)
    }).pipe(Effect.provide(Niri.live({ runner }))),
  )

  assert.strictEqual(events[0]?.["type"], "WindowFocusChanged")
  assert.strictEqual(finalized, true)
})

test("findNiriExecutable maps missing binary to NiriUnavailableError", async () => {
  const error = await Effect.runPromise(
    Effect.flip(findNiriExecutable("__effect_pie_missing_niri_binary__")),
  )

  assert.strictEqual(Reflect.get(error, "_tag"), "NiriUnavailableError")
  assert.match(error.message, /not found/)
})

test("runNiriCommand maps non-zero exits and timeouts to typed errors", async () => {
  const nonZero = await Effect.runPromise(
    Effect.flip(runNiriCommand(["sh", "-c", "echo ipc-failed >&2; exit 7"], 1_000)),
  )
  const timeout = await Effect.runPromise(
    Effect.flip(runNiriCommand([process.execPath, "-e", "setTimeout(() => {}, 1000)"], 10)),
  )

  assert.strictEqual(Reflect.get(nonZero, "_tag"), "NiriIpcError")
  assert.ok(nonZero instanceof NiriIpcError)
  assert.strictEqual(nonZero.exitCode, 7)
  assert.match(nonZero.stderr ?? "", /ipc-failed/)
  assert.strictEqual(Reflect.get(timeout, "_tag"), "NiriTimeoutError")
  assert.ok(timeout instanceof NiriTimeoutError)
})

test("streamNiriCommandLines surfaces event-stream subprocess failures", async () => {
  const error = await Effect.runPromise(
    Effect.flip(
      streamNiriCommandLines(["sh", "-c", "echo stream-failed >&2; exit 4"]).pipe(Stream.runDrain),
    ),
  )

  assert.ok(error instanceof NiriIpcError)
  assert.strictEqual(error.exitCode, 4)
  assert.match(error.stderr ?? "", /stream-failed/)
})
