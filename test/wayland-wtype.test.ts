import { expect, test } from "bun:test";

import {
  buildWtypeCommandArgs,
  buildWtypePasteShortcutArgs,
  resolveWtypeInjectionMode,
  shouldUseWtypeClipboardPaste,
} from "../src/wayland/wtype.ts";

test("buildWtypeCommandArgs builds argv with text payload", () => {
  expect(buildWtypeCommandArgs("/run/current-system/sw/bin/wtype", "hello world")).toEqual([
    "/run/current-system/sw/bin/wtype",
    "--",
    "hello world",
  ]);
});

test("buildWtypeCommandArgs adds delay when requested", () => {
  expect(buildWtypeCommandArgs("/run/current-system/sw/bin/wtype", "zazolc", 8)).toEqual([
    "/run/current-system/sw/bin/wtype",
    "-d",
    "8",
    "--",
    "zazolc",
  ]);
});

test("buildWtypePasteShortcutArgs builds Ctrl+V shortcut argv", () => {
  expect(buildWtypePasteShortcutArgs("/run/current-system/sw/bin/wtype")).toEqual([
    "/run/current-system/sw/bin/wtype",
    "-M",
    "ctrl",
    "-k",
    "v",
    "-m",
    "ctrl",
  ]);
});

test("shouldUseWtypeClipboardPaste returns true for apostrophes and quotes", () => {
  expect(shouldUseWtypeClipboardPaste("don't")).toBe(true);
  expect(shouldUseWtypeClipboardPaste('say "hi"')).toBe(true);
  expect(shouldUseWtypeClipboardPaste(`it${String.fromCharCode(0x2019)}s`)).toBe(true);
});

test("shouldUseWtypeClipboardPaste returns false for plain words", () => {
  expect(shouldUseWtypeClipboardPaste("plain text")).toBe(false);
});

test("resolveWtypeInjectionMode defaults to auto", () => {
  expect(resolveWtypeInjectionMode({})).toBe("auto");
});

test("resolveWtypeInjectionMode accepts explicit mode", () => {
  expect(resolveWtypeInjectionMode({ PIE_WAYLAND_INJECTION_MODE: "direct" })).toBe("direct");
  expect(resolveWtypeInjectionMode({ PIE_WAYLAND_INJECTION_MODE: "auto" })).toBe("auto");
});

test("resolveWtypeInjectionMode supports legacy env var", () => {
  expect(resolveWtypeInjectionMode({ EFFECT_PI_WAYLAND_INJECTION_MODE: "clipboard" })).toBe(
    "clipboard",
  );
});

test("resolveWtypeInjectionMode falls back to auto for invalid values", () => {
  expect(resolveWtypeInjectionMode({ PIE_WAYLAND_INJECTION_MODE: "weird" })).toBe("auto");
});
