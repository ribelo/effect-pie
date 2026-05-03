import { test } from "node:test"
import * as assert from "node:assert/strict"
import { Cause, Duration, Effect, Exit } from "effect"

import {
  buildWtypeCommandArgs,
  buildWtypePasteShortcutArgs,
  resolveWtypeInjectionMode,
  shouldUseWtypeClipboardPaste,
  typeTextWithWtype,
} from "../src/wayland/wtype.ts"

test("buildWtypeCommandArgs builds argv with text payload", () => {
  assert.deepStrictEqual(buildWtypeCommandArgs("/run/current-system/sw/bin/wtype", "hello world"), [
    "/run/current-system/sw/bin/wtype",
    "--",
    "hello world",
  ])
})

test("buildWtypeCommandArgs adds delay when requested", () => {
  assert.deepStrictEqual(buildWtypeCommandArgs("/run/current-system/sw/bin/wtype", "zazolc", 8), [
    "/run/current-system/sw/bin/wtype",
    "-d",
    "8",
    "--",
    "zazolc",
  ])
})

test("buildWtypePasteShortcutArgs builds Ctrl+V shortcut argv", () => {
  assert.deepStrictEqual(buildWtypePasteShortcutArgs("/run/current-system/sw/bin/wtype"), [
    "/run/current-system/sw/bin/wtype",
    "-M",
    "ctrl",
    "-k",
    "v",
    "-m",
    "ctrl",
  ])
})

test("shouldUseWtypeClipboardPaste returns true for apostrophes and quotes", () => {
  assert.strictEqual(shouldUseWtypeClipboardPaste("don't"), true)
  assert.strictEqual(shouldUseWtypeClipboardPaste('say "hi"'), true)
  assert.strictEqual(shouldUseWtypeClipboardPaste(`it${String.fromCharCode(0x2019)}s`), true)
})

test("shouldUseWtypeClipboardPaste returns false for plain words", () => {
  assert.strictEqual(shouldUseWtypeClipboardPaste("plain text"), false)
})

test("resolveWtypeInjectionMode defaults to auto", () => {
  assert.strictEqual(resolveWtypeInjectionMode({}), "auto")
})

test("resolveWtypeInjectionMode accepts explicit mode", () => {
  assert.strictEqual(resolveWtypeInjectionMode({ PIE_WAYLAND_INJECTION_MODE: "direct" }), "direct")
  assert.strictEqual(resolveWtypeInjectionMode({ PIE_WAYLAND_INJECTION_MODE: "auto" }), "auto")
})

test("resolveWtypeInjectionMode supports legacy env var", () => {
  assert.strictEqual(
    resolveWtypeInjectionMode({ EFFECT_PI_WAYLAND_INJECTION_MODE: "clipboard" }),
    "clipboard",
  )
})

test("resolveWtypeInjectionMode falls back to auto for invalid values", () => {
  assert.strictEqual(resolveWtypeInjectionMode({ PIE_WAYLAND_INJECTION_MODE: "weird" }), "auto")
})

test("typeTextWithWtype reports missing wtype as a typed failure", async () => {
  const originalWhich = Bun.which
  Bun.which = (() => null) as typeof Bun.which

  try {
    const exit = await Effect.runPromiseExit(typeTextWithWtype("hello"))

    assert.strictEqual(Exit.isFailure(exit), true)
    if (Exit.isFailure(exit)) {
      assert.strictEqual(Cause.hasFails(exit.cause), true)
      assert.strictEqual(Cause.hasDies(exit.cause), false)
    }
  } finally {
    Bun.which = originalWhich
  }
})

test("typeTextWithWtype falls back to direct typing when clipboard copy hangs", async () => {
  const originalWhich = Bun.which
  const originalSpawn = Bun.spawn
  const spawned: Array<ReadonlyArray<string>> = []

  Bun.which = ((name: string) => {
    if (name === "wtype") {
      return "/bin/wtype"
    }

    if (name === "wl-copy") {
      return "/bin/wl-copy"
    }

    return null
  }) as typeof Bun.which

  Bun.spawn = ((command: Array<string> | { readonly cmd: Array<string> }) => {
    const commandArgs = Array.isArray(command) ? command : command.cmd
    spawned.push(commandArgs)

    if (commandArgs[0] === "/bin/wl-copy") {
      return {
        exited: new Promise<number>(() => {}),
        stdout: null,
        stderr: null,
        kill: () => undefined,
      }
    }

    return {
      exited: Promise.resolve(0),
      stdout: null,
      stderr: null,
      kill: () => undefined,
    }
  }) as unknown as typeof Bun.spawn

  try {
    const text = "doesn't hang"
    const exit = await Effect.runPromiseExit(
      typeTextWithWtype(text, { commandTimeoutMs: 10 }).pipe(
        Effect.timeoutOrElse({
          duration: Duration.millis(200),
          orElse: () => Effect.fail("typing timed out"),
        }),
      ),
    )

    assert.strictEqual(Exit.isSuccess(exit), true)
    assert.deepStrictEqual(spawned.at(-1), ["/bin/wtype", "--", text])
  } finally {
    Bun.which = originalWhich
    Bun.spawn = originalSpawn
  }
})

test("typeTextWithWtype rejects command timeout values above the timer limit", async () => {
  const originalWhich = Bun.which
  const originalSpawn = Bun.spawn
  const spawned: Array<ReadonlyArray<string>> = []

  Bun.which = ((name: string) => (name === "wtype" ? "/bin/wtype" : null)) as typeof Bun.which
  Bun.spawn = ((command: Array<string> | { readonly cmd: Array<string> }) => {
    const commandArgs = Array.isArray(command) ? command : command.cmd
    spawned.push(commandArgs)

    return {
      exited: Promise.resolve(0),
      stdout: null,
      stderr: null,
      kill: () => undefined,
    }
  }) as unknown as typeof Bun.spawn

  try {
    const exit = await Effect.runPromiseExit(
      typeTextWithWtype("hello", { commandTimeoutMs: 2_147_483_648 }),
    )

    assert.strictEqual(Exit.isFailure(exit), true)
    assert.deepStrictEqual(spawned, [])
  } finally {
    Bun.which = originalWhich
    Bun.spawn = originalSpawn
  }
})
