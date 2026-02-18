import { expect, test } from "bun:test";

import {
  chooseFallbackTextInjectionBackend,
  chooseTextInjectionBackend,
} from "../src/input/textInjection.ts";

test("chooseTextInjectionBackend selects wtype for wayland", () => {
  expect(chooseTextInjectionBackend("wayland")).toBe("wtype");
});

test("chooseTextInjectionBackend selects xdotool for x11", () => {
  expect(chooseTextInjectionBackend("x11")).toBe("xdotool");
});

test("chooseTextInjectionBackend returns undefined for unknown", () => {
  expect(chooseTextInjectionBackend("unknown")).toBeUndefined();
});

test("chooseFallbackTextInjectionBackend uses xdotool when wayland backend has x11 available", () => {
  expect(
    chooseFallbackTextInjectionBackend("wtype", {
      DISPLAY: ":0",
    }),
  ).toBe("xdotool");
});

test("chooseFallbackTextInjectionBackend uses wtype when x11 backend has wayland available", () => {
  expect(
    chooseFallbackTextInjectionBackend("xdotool", {
      WAYLAND_DISPLAY: "wayland-1",
    }),
  ).toBe("wtype");
});

test("chooseFallbackTextInjectionBackend returns undefined without alternate session", () => {
  expect(chooseFallbackTextInjectionBackend("wtype", {})).toBeUndefined();
  expect(chooseFallbackTextInjectionBackend("xdotool", {})).toBeUndefined();
});
