import { test } from "node:test"
import * as assert from "node:assert/strict"
import { Effect } from "effect"

import { chooseTextInjectionBackend } from "../src/input/textInjection.ts"

test("chooseTextInjectionBackend selects wtype for wayland", () => {
  assert.strictEqual(Effect.runSync(chooseTextInjectionBackend("wayland")), "wtype")
})

test("chooseTextInjectionBackend selects xdotool for x11", () => {
  assert.strictEqual(Effect.runSync(chooseTextInjectionBackend("x11")), "xdotool")
})

test("chooseTextInjectionBackend fails for unknown session", () => {
  assert.throws(() => Effect.runSync(chooseTextInjectionBackend("unknown")))
})
