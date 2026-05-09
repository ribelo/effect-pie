import { test } from "node:test"
import * as assert from "node:assert/strict"

import { Niri, NiriTransport } from "../src/index.ts"

test("project entry point exports Niri service and transport", () => {
  assert.strictEqual(typeof Niri, "function")
  assert.strictEqual(typeof NiriTransport, "function")
})
