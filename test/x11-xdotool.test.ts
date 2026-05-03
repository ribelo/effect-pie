import { test } from "node:test"
import * as assert from "node:assert/strict"
import { Cause, Effect, Exit } from "effect"

import { buildXdotoolCommandArgs, typeTextWithXdotool } from "../src/x11/xdotool.ts"

test("buildXdotoolCommandArgs builds argv with text payload", () => {
  assert.deepStrictEqual(buildXdotoolCommandArgs("/usr/bin/xdotool", "hello world"), [
    "/usr/bin/xdotool",
    "type",
    "--clearmodifiers",
    "--",
    "hello world",
  ])
})

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
