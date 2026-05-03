import { test } from "node:test"
import * as assert from "node:assert/strict"

import {
  chooseFallbackTextInjectionBackend,
  chooseTextInjectionBackend,
} from "../src/input/textInjection.ts"

test("chooseTextInjectionBackend selects wtype for wayland", () => {
  assert.strictEqual(chooseTextInjectionBackend("wayland"), "wtype")
})

test("chooseTextInjectionBackend selects xdotool for x11", () => {
  assert.strictEqual(chooseTextInjectionBackend("x11"), "xdotool")
})

test("chooseTextInjectionBackend returns undefined for unknown", () => {
  assert.strictEqual(chooseTextInjectionBackend("unknown"), undefined)
})

test("chooseFallbackTextInjectionBackend uses xdotool when wayland backend has x11 available", () => {
  assert.strictEqual(
    chooseFallbackTextInjectionBackend("wtype", {
      DISPLAY: ":0",
    }),
    "xdotool",
  )
})

test("chooseFallbackTextInjectionBackend uses wtype when x11 backend has wayland available", () => {
  assert.strictEqual(
    chooseFallbackTextInjectionBackend("xdotool", {
      WAYLAND_DISPLAY: "wayland-1",
    }),
    "wtype",
  )
})

test("chooseFallbackTextInjectionBackend returns undefined without alternate session", () => {
  assert.strictEqual(chooseFallbackTextInjectionBackend("wtype", {}), undefined)
  assert.strictEqual(chooseFallbackTextInjectionBackend("xdotool", {}), undefined)
})
