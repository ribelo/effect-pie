import { test } from "node:test"
import * as assert from "node:assert/strict"
import { Effect } from "effect"

import {
  chooseTextInjectionBackend,
  normalizeTextDeltaForInjection,
  normalizeTextForInjection,
} from "../src/input/textInjection.ts"

test("chooseTextInjectionBackend selects wtype for wayland", () => {
  assert.strictEqual(Effect.runSync(chooseTextInjectionBackend("wayland")), "wtype")
})

test("chooseTextInjectionBackend selects xdotool for x11", () => {
  assert.strictEqual(Effect.runSync(chooseTextInjectionBackend("x11")), "xdotool")
})

test("chooseTextInjectionBackend fails for unknown session", () => {
  assert.throws(() => Effect.runSync(chooseTextInjectionBackend("unknown")))
})

test("normalizeTextForInjection collapses line breaks to spaces", () => {
  assert.strictEqual(
    normalizeTextForInjection("  first line\nsecond line\r\n third line  "),
    "first line second line third line",
  )
})

test("normalizeTextDeltaForInjection keeps newline deltas safe for streaming", () => {
  assert.strictEqual(normalizeTextDeltaForInjection("\n"), " ")
  assert.strictEqual(normalizeTextDeltaForInjection("hello\nworld"), "hello world")
})
