import { test } from "node:test"
import * as assert from "node:assert/strict"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"

import { Niri } from "../src/niri/service.ts"
import { NiriTransport } from "../src/niri/transport.ts"

const testLayer = (transport: NiriTransport["Service"]) =>
  Niri.layer.pipe(Layer.provide(Layer.succeed(NiriTransport, NiriTransport.of(transport))))

test("Niri read APIs decode successful payloads and null focused-window absence", async () => {
  const layer = testLayer({
    read: (request) =>
      Effect.succeed(
        request === "version"
          ? JSON.stringify({ cli: "25.11", compositor: "25.11" })
          : request === "focused-window"
            ? "null"
            : request === "overview-state"
              ? JSON.stringify({ is_open: false })
              : "[]",
      ),
    runAction: () => Effect.void,
    runOutput: () => Effect.succeed("Applied"),
    eventStreamLines: Stream.empty,
  })

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const niri = yield* Niri
      const version = yield* niri.version
      const focusedWindow = yield* niri.focusedWindow
      const overview = yield* niri.overviewState
      return { version, focusedWindow, overview }
    }).pipe(Effect.provide(layer)),
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
  const payloads = {
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
  } as const

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
    }).pipe(
      Effect.provide(
        testLayer({
          read: (request) => Effect.succeed(JSON.stringify(payloads[request])),
          runAction: () => Effect.void,
          runOutput: () => Effect.succeed(JSON.stringify("Applied")),
          eventStreamLines: Stream.empty,
        }),
      ),
    ),
  )

  assert.strictEqual(result.outputs["DP-1"]?.name, "DP-1")
  assert.strictEqual(result.workspaces[0]?.id, 2)
  assert.strictEqual(result.windows[0]?.id, 1)
  assert.strictEqual(result.layers[0]?.namespace, "bar")
  assert.strictEqual(result.keyboardLayouts.names[0], "Polish")
  assert.strictEqual(result.focusedOutput?.name, "DP-1")
  assert.strictEqual(result.focusedWindow?.id, 1)
  assert.strictEqual(result.pickWindow?.id, 1)
  assert.deepStrictEqual(result.pickColor?.rgb, [0.1, 0.2, 0.3])
  assert.strictEqual(result.overviewState.is_open, false)
})

test("Niri read APIs fail with typed decode errors for wrong payload shape", async () => {
  const error = await Effect.runPromise(
    Effect.flip(
      Effect.gen(function* () {
        const niri = yield* Niri
        return yield* niri.version
      }).pipe(
        Effect.provide(
          testLayer({
            read: () => Effect.succeed(JSON.stringify({ compositor: 42 })),
            runAction: () => Effect.void,
            runOutput: () => Effect.succeed("Applied"),
            eventStreamLines: Stream.empty,
          }),
        ),
      ),
    ),
  )

  assert.strictEqual(Reflect.get(error, "_tag"), "NiriDecodeError")
})

test("Niri action and output APIs delegate typed commands to the transport", async () => {
  const calls: Array<unknown> = []

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
    }).pipe(
      Effect.provide(
        testLayer({
          read: () => Effect.succeed("null"),
          runAction: (action) => Effect.sync(() => void calls.push(action)),
          runOutput: (output, action) =>
            Effect.sync(() => {
              calls.push({ output, action })
              return JSON.stringify("Applied")
            }),
          eventStreamLines: Stream.empty,
        }),
      ),
    ),
  )

  assert.deepStrictEqual(calls, [
    { type: "focus-window", id: 7 },
    {
      type: "move-window-to-workspace",
      reference: { type: "index", index: 3 },
      windowId: 8,
      focus: false,
    },
    { output: "DP-1", action: { type: "scale", scale: 2 } },
    { output: "DP-1", action: { type: "custom-mode", width: 1920, height: 1080, refresh: 60 } },
    { output: "DP-1", action: { type: "position", position: { type: "set", x: 10, y: 20 } } },
    { output: "DP-1", action: { type: "vrr", enabled: true, onDemand: true } },
  ])
})

test("Niri event stream decodes lines and runs stream finalizers", async () => {
  let finalized = false
  const layer = testLayer({
    read: () => Effect.succeed("null"),
    runAction: () => Effect.void,
    runOutput: () => Effect.succeed("Applied"),
    eventStreamLines: Stream.fromIterable([
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
    }).pipe(Effect.provide(layer)),
  )

  assert.strictEqual(events[0]?.type, "WindowFocusChanged")
  assert.strictEqual(finalized, true)
})
