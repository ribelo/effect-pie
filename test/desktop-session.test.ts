import { test } from "node:test"
import * as assert from "node:assert/strict"

import { detectDesktopSessionType } from "../src/desktop/session.ts"

test("detectDesktopSessionType prefers XDG_SESSION_TYPE when wayland", () => {
  assert.strictEqual(
    detectDesktopSessionType({
      XDG_SESSION_TYPE: "wayland",
      DISPLAY: ":0",
      WAYLAND_DISPLAY: "wayland-1",
    }),
    "wayland",
  )
})

test("detectDesktopSessionType prefers XDG_SESSION_TYPE when x11", () => {
  assert.strictEqual(
    detectDesktopSessionType({
      XDG_SESSION_TYPE: "x11",
      DISPLAY: ":0",
      WAYLAND_DISPLAY: "wayland-1",
    }),
    "x11",
  )
})

test("detectDesktopSessionType falls back to WAYLAND_DISPLAY", () => {
  assert.strictEqual(
    detectDesktopSessionType({
      WAYLAND_DISPLAY: "wayland-1",
    }),
    "wayland",
  )
})

test("detectDesktopSessionType falls back to DISPLAY", () => {
  assert.strictEqual(
    detectDesktopSessionType({
      DISPLAY: ":0",
    }),
    "x11",
  )
})

test("detectDesktopSessionType returns unknown when no session hints exist", () => {
  assert.strictEqual(detectDesktopSessionType({}), "unknown")
})
