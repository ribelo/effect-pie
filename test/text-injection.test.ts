import { test } from "node:test"
import * as assert from "node:assert/strict"
import { Effect } from "effect"

import { DesktopSession } from "../src/desktop/session.js"
import {
  chooseTextInjectionBackend,
  injectTranscript,
  normalizeTextDeltaForInjection,
  normalizeTextForInjection,
  TextInjectionBackendService,
} from "../src/input/textInjection.ts"

const fakeWaylandDesktop = DesktopSession.of({
  detect: Effect.succeed("wayland"),
})

const fakeNoopTextInjection = TextInjectionBackendService.of({
  backend: "wtype",
  typeText: () => Effect.void,
})

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

test("injectTranscript notifies when the normalized transcript is empty", async () => {
  const notifications: Array<{ title: string; message: string }> = []

  const result = await Effect.runPromise(
    injectTranscript({
      text: " \n ",
      logPrefix: "test",
      notifyEmptyTranscript: (title, message) =>
        Effect.sync(() => {
          notifications.push({ title, message })
        }),
    }).pipe(
      Effect.provideService(DesktopSession, fakeWaylandDesktop),
      Effect.provideService(TextInjectionBackendService, fakeNoopTextInjection),
    ),
  )

  assert.strictEqual(result, undefined)
  assert.deepStrictEqual(notifications, [
    {
      title: "pie: no transcript",
      message:
        "Speech-to-text produced no transcript text. Try speaking louder or checking microphone input.",
    },
  ])
})
