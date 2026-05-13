import { test } from "node:test"
import * as assert from "node:assert/strict"

import { Niri } from "../src/index.ts"

test("project entry point exports Niri service", () => {
  assert.strictEqual(typeof Niri, "function")
})
