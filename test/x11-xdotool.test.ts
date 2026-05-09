import { test } from "node:test"
import * as assert from "node:assert/strict"
import { Cause, Effect, Exit } from "effect"

import { typeTextWithXdotool } from "../src/x11/xdotool.ts"

test("typeTextWithXdotool reports missing xdotool as a typed failure", async () => {
  const originalWhich = Bun.which
  Bun.which = (() => null) as typeof Bun.which

  try {
    const exit = await Effect.runPromiseExit(typeTextWithXdotool("hello"))

    assert.strictEqual(Exit.isFailure(exit), true)
    if (Exit.isFailure(exit)) {
      assert.strictEqual(Cause.hasFails(exit.cause), true)
      assert.strictEqual(Cause.hasDies(exit.cause), false)
    }
  } finally {
    Bun.which = originalWhich
  }
})

test("typeTextWithXdotool collapses trailing translation newlines before typing", async () => {
  const originalWhich = Bun.which
  const originalSpawn = Bun.spawn
  const spawned: Array<ReadonlyArray<string>> = []

  Bun.which = ((name: string) => (name === "xdotool" ? "/bin/xdotool" : null)) as typeof Bun.which
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
    await Effect.runPromise(typeTextWithXdotool("Translated response\n"))

    assert.deepStrictEqual(spawned.at(-1), [
      "/bin/xdotool",
      "type",
      "--clearmodifiers",
      "--",
      "Translated response",
    ])
  } finally {
    Bun.which = originalWhich
    Bun.spawn = originalSpawn
  }
})

test("typeTextWithXdotool preserves streamed delta boundary spaces", async () => {
  const originalWhich = Bun.which
  const originalSpawn = Bun.spawn
  const spawned: Array<ReadonlyArray<string>> = []

  Bun.which = ((name: string) => (name === "xdotool" ? "/bin/xdotool" : null)) as typeof Bun.which
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
    await Effect.runPromise(typeTextWithXdotool("hello "))
    await Effect.runPromise(typeTextWithXdotool(" world"))

    assert.deepStrictEqual(
      spawned.map((args) => args.at(-1)),
      ["hello ", " world"],
    )
  } finally {
    Bun.which = originalWhich
    Bun.spawn = originalSpawn
  }
})
