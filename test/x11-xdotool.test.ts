import { expect, test } from "bun:test";

import { buildXdotoolCommandArgs } from "../src/x11/xdotool.ts";

test("buildXdotoolCommandArgs builds argv with text payload", () => {
  expect(buildXdotoolCommandArgs("/usr/bin/xdotool", "hello world")).toEqual([
    "/usr/bin/xdotool",
    "type",
    "--clearmodifiers",
    "--",
    "hello world",
  ]);
});
