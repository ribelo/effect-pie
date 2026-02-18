import { expect, test } from "bun:test";

import {
  buildBindShortcutsArgs,
  buildCreateSessionOptionsArgs,
  deriveSessionHandleFromRequestHandle,
  parseObjectPathFromBusctlCallOutput,
  parseRequestResponseCodeFromBusctlWaitOutput,
  parseSessionHandleFromRequestResponseOutput,
} from "../src/wayland/globalShortcuts.ts";

test("buildCreateSessionOptionsArgs serializes portal tokens", () => {
  expect(
    buildCreateSessionOptionsArgs({
      handleToken: "handle_token_1",
      sessionHandleToken: "session_token_2",
    }),
  ).toEqual([
    "2",
    "handle_token",
    "s",
    "handle_token_1",
    "session_handle_token",
    "s",
    "session_token_2",
  ]);
});

test("buildBindShortcutsArgs serializes shortcut payload", () => {
  expect(
    buildBindShortcutsArgs({
      sessionHandle: "/org/freedesktop/portal/desktop/session/1_20/example_session",
      shortcut: {
        id: "push_to_talk",
        description: "effect-pi push-to-talk",
        preferredTrigger: "<Ctrl><Super>space",
      },
      parentWindow: "",
    }),
  ).toEqual([
    "/org/freedesktop/portal/desktop/session/1_20/example_session",
    "1",
    "push_to_talk",
    "2",
    "description",
    "s",
    "effect-pi push-to-talk",
    "preferred_trigger",
    "s",
    "<Ctrl><Super>space",
    "",
    "0",
  ]);
});

test("deriveSessionHandleFromRequestHandle builds expected session path", () => {
  expect(
    deriveSessionHandleFromRequestHandle(
      "/org/freedesktop/portal/desktop/request/1_42/effect_pi_req_abc123",
      "effect_pi_session_xyz999",
    ),
  ).toBe("/org/freedesktop/portal/desktop/session/1_42/effect_pi_session_xyz999");

  expect(deriveSessionHandleFromRequestHandle("/invalid/path", "session")).toBeUndefined();
});

test("parseObjectPathFromBusctlCallOutput extracts object path", () => {
  expect(
    parseObjectPathFromBusctlCallOutput(
      'o "/org/freedesktop/portal/desktop/request/1_42/effect_pi_req_abc123"',
    ),
  ).toBe("/org/freedesktop/portal/desktop/request/1_42/effect_pi_req_abc123");

  expect(parseObjectPathFromBusctlCallOutput("unexpected output")).toBeUndefined();
});

test("parseRequestResponseCodeFromBusctlWaitOutput extracts response code", () => {
  expect(parseRequestResponseCodeFromBusctlWaitOutput("ua{sv} 0 0")).toBe(0);
  expect(
    parseRequestResponseCodeFromBusctlWaitOutput(
      'ua{sv} 2 1 "session_handle" s "/org/freedesktop/portal/desktop/session/1_42/token"',
    ),
  ).toBe(2);
  expect(parseRequestResponseCodeFromBusctlWaitOutput("invalid output")).toBeUndefined();
});

test("parseSessionHandleFromRequestResponseOutput extracts session handle", () => {
  expect(
    parseSessionHandleFromRequestResponseOutput(
      'ua{sv} 0 1 "session_handle" s "/org/freedesktop/portal/desktop/session/1_42/token"',
    ),
  ).toBe("/org/freedesktop/portal/desktop/session/1_42/token");

  expect(
    parseSessionHandleFromRequestResponseOutput(
      'ua{sv} 0 1 "session_handle" o "/org/freedesktop/portal/desktop/session/1_42/token"',
    ),
  ).toBe("/org/freedesktop/portal/desktop/session/1_42/token");

  expect(parseSessionHandleFromRequestResponseOutput("ua{sv} 0 0")).toBeUndefined();
});
