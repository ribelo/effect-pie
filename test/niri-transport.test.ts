import { test } from "node:test"
import * as assert from "node:assert/strict"

import {
  buildNiriActionCommand,
  buildNiriEventStreamCommand,
  buildNiriOutputCommand,
  buildNiriReadCommand,
  findNiriExecutable,
  runNiriCommand,
  sizeChangeArg,
  streamNiriCommandLines,
  workspaceReferenceArg,
} from "../src/niri/transport.ts"
import { NiriIpcError, NiriTimeoutError } from "../src/niri/errors.ts"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"

test("buildNiriReadCommand builds local JSON read commands", () => {
  assert.deepStrictEqual(buildNiriReadCommand("/usr/bin/niri", "focused-window"), [
    "/usr/bin/niri",
    "msg",
    "--json",
    "focused-window",
  ])
  assert.deepStrictEqual(buildNiriEventStreamCommand("/usr/bin/niri"), [
    "/usr/bin/niri",
    "msg",
    "--json",
    "event-stream",
  ])
})

test("buildNiriActionCommand builds representative typed action argv", () => {
  assert.deepStrictEqual(buildNiriActionCommand("niri", { type: "close-window", id: 42 }), [
    "niri",
    "msg",
    "action",
    "close-window",
    "--id",
    "42",
  ])
  assert.deepStrictEqual(
    buildNiriActionCommand("niri", {
      type: "move-window-to-workspace",
      reference: { type: "name", name: "chat" },
      windowId: 99,
      focus: false,
    }),
    [
      "niri",
      "msg",
      "action",
      "move-window-to-workspace",
      "--window-id",
      "99",
      "--focus",
      "false",
      "chat",
    ],
  )
  assert.deepStrictEqual(
    buildNiriActionCommand("niri", {
      type: "screenshot-window",
      id: 12,
      writeToDisk: false,
      showPointer: true,
      path: "/tmp/window.png",
    }),
    [
      "niri",
      "msg",
      "action",
      "screenshot-window",
      "--id",
      "12",
      "--write-to-disk",
      "false",
      "--show-pointer",
      "true",
      "--path",
      "/tmp/window.png",
    ],
  )
  assert.deepStrictEqual(
    buildNiriActionCommand("niri", {
      type: "set-window-width",
      change: { type: "adjust-proportion", value: -0.1 },
    }),
    ["niri", "msg", "action", "set-window-width", "-10%"],
  )
  assert.deepStrictEqual(
    buildNiriActionCommand("niri", { type: "set-dynamic-cast-monitor", output: "DP-1" }),
    ["niri", "msg", "action", "set-dynamic-cast-monitor", "DP-1"],
  )
  assert.deepStrictEqual(
    buildNiriActionCommand("niri", { type: "toggle-window-floating", id: 55 }),
    ["niri", "msg", "action", "toggle-window-floating", "--id", "55"],
  )
})

test("buildNiriOutputCommand builds every output action family", () => {
  assert.deepStrictEqual(buildNiriOutputCommand("niri", "DP-1", { type: "off" }), [
    "niri",
    "msg",
    "--json",
    "output",
    "DP-1",
    "off",
  ])
  assert.deepStrictEqual(buildNiriOutputCommand("niri", "DP-1", { type: "mode", mode: "auto" }), [
    "niri",
    "msg",
    "--json",
    "output",
    "DP-1",
    "mode",
    "auto",
  ])
  assert.deepStrictEqual(
    buildNiriOutputCommand("niri", "DP-1", {
      type: "custom-mode",
      width: 1920,
      height: 1080,
      refresh: 60,
    }),
    ["niri", "msg", "--json", "output", "DP-1", "custom-mode", "1920x1080@60"],
  )
  assert.deepStrictEqual(
    buildNiriOutputCommand("niri", "DP-1", {
      type: "modeline",
      clock: 174.5,
      hdisplay: 1920,
      hsyncStart: 1968,
      hsyncEnd: 2000,
      htotal: 2080,
      vdisplay: 1080,
      vsyncStart: 1083,
      vsyncEnd: 1088,
      vtotal: 1111,
      hsyncPolarity: "+hsync",
      vsyncPolarity: "-vsync",
    }),
    [
      "niri",
      "msg",
      "--json",
      "output",
      "DP-1",
      "modeline",
      "174.5",
      "1920",
      "1968",
      "2000",
      "2080",
      "1080",
      "1083",
      "1088",
      "1111",
      "+hsync",
      "-vsync",
    ],
  )
  assert.deepStrictEqual(buildNiriOutputCommand("niri", "DP-1", { type: "scale", scale: 1.25 }), [
    "niri",
    "msg",
    "--json",
    "output",
    "DP-1",
    "scale",
    "1.25",
  ])
  assert.deepStrictEqual(
    buildNiriOutputCommand("niri", "DP-1", { type: "transform", transform: "flipped-90" }),
    ["niri", "msg", "--json", "output", "DP-1", "transform", "flipped-90"],
  )
  assert.deepStrictEqual(
    buildNiriOutputCommand("niri", "DP-1", {
      type: "position",
      position: { type: "set", x: -1920, y: 0 },
    }),
    ["niri", "msg", "--json", "output", "DP-1", "position", "set", "-1920", "0"],
  )
  assert.deepStrictEqual(
    buildNiriOutputCommand("niri", "DP-1", { type: "vrr", enabled: true, onDemand: true }),
    ["niri", "msg", "--json", "output", "DP-1", "vrr", "--on-demand", "true"],
  )
})

test("command helpers reject invalid ids, indexes, names, and change values before spawning", () => {
  assert.throws(() => buildNiriActionCommand("niri", { type: "focus-window", id: 0 }), /positive/)
  assert.throws(() => buildNiriOutputCommand("niri", " ", { type: "on" }), /output name/)
  assert.throws(() => workspaceReferenceArg({ type: "name", name: "" }), /workspace name/)
  assert.throws(() => sizeChangeArg({ type: "set-proportion", value: 0 }), /proportion/)
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
