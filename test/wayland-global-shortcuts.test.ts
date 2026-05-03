import { test } from "node:test";
import * as assert from "node:assert/strict";

import {
  buildBindShortcutsArgs,
  buildCreateSessionOptionsArgs,
  deriveSessionHandleFromRequestHandle,
  parseObjectPathFromBusctlCallOutput,
  parseRequestResponseCodeFromBusctlWaitOutput,
  parseSessionHandleFromRequestResponseOutput,
} from "../src/wayland/globalShortcuts.ts";

test("buildCreateSessionOptionsArgs serializes portal tokens", () => {
  assert.deepStrictEqual(
    buildCreateSessionOptionsArgs({
      handleToken: "handle_token_1",
      sessionHandleToken: "session_token_2",
    }),
    ["2", "handle_token", "s", "handle_token_1", "session_handle_token", "s", "session_token_2"],
  );
});

test("buildBindShortcutsArgs serializes shortcut payload", () => {
  assert.deepStrictEqual(
    buildBindShortcutsArgs({
      sessionHandle: "/org/freedesktop/portal/desktop/session/1_20/example_session",
      shortcut: {
        id: "push_to_talk",
        description: "pie push-to-talk",
        preferredTrigger: "<Ctrl><Super>space",
      },
      parentWindow: "",
    }),
    [
      "/org/freedesktop/portal/desktop/session/1_20/example_session",
      "1",
      "push_to_talk",
      "2",
      "description",
      "s",
      "pie push-to-talk",
      "preferred_trigger",
      "s",
      "<Ctrl><Super>space",
      "",
      "0",
    ],
  );
});

test("deriveSessionHandleFromRequestHandle builds expected session path", () => {
  assert.strictEqual(
    deriveSessionHandleFromRequestHandle(
      "/org/freedesktop/portal/desktop/request/1_42/pie_req_abc123",
      "pie_session_xyz999",
    ),
    "/org/freedesktop/portal/desktop/session/1_42/pie_session_xyz999",
  );

  assert.strictEqual(deriveSessionHandleFromRequestHandle("/invalid/path", "session"), undefined);
});

test("parseObjectPathFromBusctlCallOutput extracts object path", () => {
  assert.strictEqual(
    parseObjectPathFromBusctlCallOutput(
      'o "/org/freedesktop/portal/desktop/request/1_42/pie_req_abc123"',
    ),
    "/org/freedesktop/portal/desktop/request/1_42/pie_req_abc123",
  );

  assert.strictEqual(parseObjectPathFromBusctlCallOutput("unexpected output"), undefined);
});

test("parseRequestResponseCodeFromBusctlWaitOutput extracts response code", () => {
  assert.strictEqual(parseRequestResponseCodeFromBusctlWaitOutput("ua{sv} 0 0"), 0);
  assert.strictEqual(
    parseRequestResponseCodeFromBusctlWaitOutput(
      'ua{sv} 2 1 "session_handle" s "/org/freedesktop/portal/desktop/session/1_42/token"',
    ),
    2,
  );
  assert.strictEqual(parseRequestResponseCodeFromBusctlWaitOutput("invalid output"), undefined);
});

test("parseSessionHandleFromRequestResponseOutput extracts session handle", () => {
  assert.strictEqual(
    parseSessionHandleFromRequestResponseOutput(
      'ua{sv} 0 1 "session_handle" s "/org/freedesktop/portal/desktop/session/1_42/token"',
    ),
    "/org/freedesktop/portal/desktop/session/1_42/token",
  );

  assert.strictEqual(
    parseSessionHandleFromRequestResponseOutput(
      'ua{sv} 0 1 "session_handle" o "/org/freedesktop/portal/desktop/session/1_42/token"',
    ),
    "/org/freedesktop/portal/desktop/session/1_42/token",
  );

  assert.strictEqual(parseSessionHandleFromRequestResponseOutput("ua{sv} 0 0"), undefined);
});
