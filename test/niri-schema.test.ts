import { test } from "node:test"
import * as assert from "node:assert/strict"
import * as Effect from "effect/Effect"

import {
  decodeNiriEventJson,
  decodeNiriJson,
  FocusedWindowSchema,
  OutputConfigChangedSchema,
  OutputsSchema,
  type NiriEvent,
  WindowsSchema,
} from "../src/niri/schema.ts"

const sampleWindow = {
  id: 311,
  title: "Open Files",
  app_id: "org.gnome.Nautilus",
  pid: 2808644,
  workspace_id: 1,
  is_focused: true,
  is_floating: true,
  is_urgent: false,
  layout: {
    pos_in_scrolling_layout: null,
    tile_size: [960.0, 739.0],
    window_size: [956, 735],
    tile_pos_in_workspace_view: [480.0, 183.0],
    window_offset_in_tile: [2.0, 2.0],
  },
  focus_timestamp: { secs: 523856, nanos: 936196694 },
}

test("decodeNiriJson decodes focused-window metadata and ignores unknown fields", async () => {
  const window = await Effect.runPromise(
    decodeNiriJson(
      "focused-window",
      FocusedWindowSchema,
      JSON.stringify({ ...sampleWindow, future: true }),
    ),
  )

  assert.ok(window !== null)
  assert.strictEqual(window.id, 311)
  assert.strictEqual(window.title, "Open Files")
  assert.strictEqual(window.app_id, "org.gnome.Nautilus")
  assert.strictEqual(window.pid, 2808644)
  assert.strictEqual(window.workspace_id, 1)
  assert.strictEqual(window.is_focused, true)
  assert.strictEqual(window.is_floating, true)
  assert.strictEqual(window.is_urgent, false)
  assert.deepStrictEqual(window.layout.tile_size, [960, 739])
  assert.deepStrictEqual(window.layout.window_size, [956, 735])
  assert.deepStrictEqual(window.layout.tile_pos_in_workspace_view, [480, 183])
  assert.deepStrictEqual(window.focus_timestamp, { secs: 523856, nanos: 936196694 })
  assert.strictEqual("future" in window, false)
})

test("decodeNiriJson rejects malformed required window fields with a typed decode error", async () => {
  const error = await Effect.runPromise(
    Effect.flip(
      decodeNiriJson("windows", WindowsSchema, JSON.stringify([{ ...sampleWindow, id: "bad" }])),
    ),
  )

  assert.strictEqual(Reflect.get(error, "_tag"), "NiriDecodeError")
  assert.match(error.message, /windows/)
})

test("decodeNiriJson decodes outputs and output configuration result", async () => {
  const outputs = await Effect.runPromise(
    decodeNiriJson(
      "outputs",
      OutputsSchema,
      JSON.stringify({
        "DP-1": {
          name: "DP-1",
          make: "PNP(BNQ)",
          model: "BenQ RD320U",
          serial: null,
          physical_size: [700, 390],
          modes: [{ width: 3840, height: 2160, refresh_rate: 60000, is_preferred: true }],
          current_mode: 0,
          is_custom_mode: false,
          vrr_supported: false,
          vrr_enabled: false,
          logical: { x: 0, y: 0, width: 1920, height: 1080, scale: 2, transform: "Normal" },
        },
      }),
    ),
  )
  const outputResult = await Effect.runPromise(
    decodeNiriJson("output", OutputConfigChangedSchema, JSON.stringify("Applied")),
  )

  assert.strictEqual(outputs["DP-1"]?.logical?.transform, "Normal")
  assert.strictEqual(outputResult, "Applied")
})

test("decodeNiriEventJson decodes documented event variants including focus and casts", async () => {
  const events = await Effect.runPromise(
    Effect.all([
      decodeNiriEventJson(JSON.stringify({ WindowFocusChanged: { id: 311 } })),
      decodeNiriEventJson(
        JSON.stringify({ WindowLayoutsChanged: { changes: [[311, sampleWindow.layout]] } }),
      ),
      decodeNiriEventJson(
        JSON.stringify({
          CastStartedOrChanged: {
            cast: {
              stream_id: 8,
              session_id: 9,
              kind: "PipeWire",
              target: { Window: { id: 311 } },
              is_dynamic_target: true,
              is_active: true,
              pid: 1234,
              pw_node_id: 77,
            },
          },
        }),
      ),
    ]),
  )

  assert.deepStrictEqual(
    events.map((event: NiriEvent) => event.type),
    ["WindowFocusChanged", "WindowLayoutsChanged", "CastStartedOrChanged"],
  )
})

test("decodeNiriEventJson decodes every documented event envelope", async () => {
  const events = [
    { WorkspacesChanged: { workspaces: [] } },
    { WorkspaceUrgencyChanged: { id: 1, urgent: true } },
    { WorkspaceActivated: { id: 1, focused: false } },
    { WorkspaceActiveWindowChanged: { workspace_id: 1, active_window_id: null } },
    { WindowsChanged: { windows: [] } },
    { WindowOpenedOrChanged: { window: sampleWindow } },
    { WindowClosed: { id: 1 } },
    { WindowFocusChanged: { id: null } },
    { WindowFocusTimestampChanged: { id: 1, focus_timestamp: null } },
    { WindowUrgencyChanged: { id: 1, urgent: false } },
    { WindowLayoutsChanged: { changes: [[1, sampleWindow.layout]] } },
    { KeyboardLayoutsChanged: { keyboard_layouts: { names: ["Polish"], current_idx: 0 } } },
    { KeyboardLayoutSwitched: { idx: 0 } },
    { OverviewOpenedOrClosed: { is_open: true } },
    { ConfigLoaded: { failed: false } },
    { ScreenshotCaptured: { path: null } },
    { CastsChanged: { casts: [] } },
    {
      CastStartedOrChanged: {
        cast: {
          stream_id: 1,
          session_id: 2,
          kind: "WlrScreencopy",
          target: { Nothing: {} },
          is_dynamic_target: false,
          is_active: true,
          pid: null,
          pw_node_id: null,
        },
      },
    },
    { CastStopped: { stream_id: 1 } },
  ]

  const decoded = await Effect.runPromise(
    Effect.all(events.map((event) => decodeNiriEventJson(JSON.stringify(event)))),
  )

  assert.deepStrictEqual(
    decoded.map((event) => event.type),
    events.map((event) => Object.keys(event)[0]),
  )
})
