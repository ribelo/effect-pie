import { test } from "node:test"
import * as assert from "node:assert/strict"

import { chooseTextInjectionBackend } from "../src/input/textInjection.ts"

test("chooseTextInjectionBackend selects wtype for wayland", () => {
  assert.strictEqual(chooseTextInjectionBackend("wayland"), "wtype")
})

test("chooseTextInjectionBackend selects xdotool for x11", () => {
  assert.strictEqual(chooseTextInjectionBackend("x11"), "xdotool")
})

test("chooseTextInjectionBackend returns undefined for unknown", () => {
  assert.strictEqual(chooseTextInjectionBackend("unknown"), undefined)
})
