import { expect, test } from "bun:test";

import { buildWtypeCommandArgs } from "../src/wayland/wtype.ts";

test("buildWtypeCommandArgs builds argv with text payload", () => {
  expect(buildWtypeCommandArgs("/run/current-system/sw/bin/wtype", "hello world")).toEqual([
    "/run/current-system/sw/bin/wtype",
    "--",
    "hello world",
  ]);
});
