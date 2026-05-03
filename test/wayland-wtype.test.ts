import { test } from "node:test";
import * as assert from "node:assert/strict";

import {
  buildWtypeCommandArgs,
  buildWtypePasteShortcutArgs,
  resolveWtypeInjectionMode,
  shouldUseWtypeClipboardPaste,
} from "../src/wayland/wtype.ts";

test("buildWtypeCommandArgs builds argv with text payload", () => {
  assert.deepStrictEqual(buildWtypeCommandArgs("/run/current-system/sw/bin/wtype", "hello world"), [
    "/run/current-system/sw/bin/wtype",
    "--",
    "hello world",
  ]);
});

test("buildWtypeCommandArgs adds delay when requested", () => {
  assert.deepStrictEqual(buildWtypeCommandArgs("/run/current-system/sw/bin/wtype", "zazolc", 8), [
    "/run/current-system/sw/bin/wtype",
    "-d",
    "8",
    "--",
    "zazolc",
  ]);
});

test("buildWtypePasteShortcutArgs builds Ctrl+V shortcut argv", () => {
  assert.deepStrictEqual(buildWtypePasteShortcutArgs("/run/current-system/sw/bin/wtype"), [
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
  assert.strictEqual(shouldUseWtypeClipboardPaste("don't"), true);
  assert.strictEqual(shouldUseWtypeClipboardPaste('say "hi"'), true);
  assert.strictEqual(shouldUseWtypeClipboardPaste(`it${String.fromCharCode(0x2019)}s`), true);
});

test("shouldUseWtypeClipboardPaste returns false for plain words", () => {
  assert.strictEqual(shouldUseWtypeClipboardPaste("plain text"), false);
});

test("resolveWtypeInjectionMode defaults to auto", () => {
  assert.strictEqual(resolveWtypeInjectionMode({}), "auto");
});

test("resolveWtypeInjectionMode accepts explicit mode", () => {
  assert.strictEqual(resolveWtypeInjectionMode({ PIE_WAYLAND_INJECTION_MODE: "direct" }), "direct");
  assert.strictEqual(resolveWtypeInjectionMode({ PIE_WAYLAND_INJECTION_MODE: "auto" }), "auto");
});

test("resolveWtypeInjectionMode supports legacy env var", () => {
  assert.strictEqual(
    resolveWtypeInjectionMode({ EFFECT_PI_WAYLAND_INJECTION_MODE: "clipboard" }),
    "clipboard",
  );
});

test("resolveWtypeInjectionMode falls back to auto for invalid values", () => {
  assert.strictEqual(resolveWtypeInjectionMode({ PIE_WAYLAND_INJECTION_MODE: "weird" }), "auto");
});
