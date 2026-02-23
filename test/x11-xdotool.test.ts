import { test } from "node:test";
import * as assert from "node:assert/strict";

import { buildXdotoolCommandArgs } from "../src/x11/xdotool.ts";

test("buildXdotoolCommandArgs builds argv with text payload", () => {
  assert.deepStrictEqual(buildXdotoolCommandArgs("/usr/bin/xdotool", "hello world"), [
    "/usr/bin/xdotool",
    "type",
    "--clearmodifiers",
    "--",
    "hello world",
  ]);
});
