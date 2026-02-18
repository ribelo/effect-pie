import { expect, test } from "bun:test";

import { detectDesktopSessionType } from "../src/desktop/session.ts";

test("detectDesktopSessionType prefers XDG_SESSION_TYPE when wayland", () => {
  expect(
    detectDesktopSessionType({
      XDG_SESSION_TYPE: "wayland",
      DISPLAY: ":0",
      WAYLAND_DISPLAY: "wayland-1",
    }),
  ).toBe("wayland");
});

test("detectDesktopSessionType prefers XDG_SESSION_TYPE when x11", () => {
  expect(
    detectDesktopSessionType({
      XDG_SESSION_TYPE: "x11",
      DISPLAY: ":0",
      WAYLAND_DISPLAY: "wayland-1",
    }),
  ).toBe("x11");
});

test("detectDesktopSessionType falls back to WAYLAND_DISPLAY", () => {
  expect(
    detectDesktopSessionType({
      WAYLAND_DISPLAY: "wayland-1",
    }),
  ).toBe("wayland");
});

test("detectDesktopSessionType falls back to DISPLAY", () => {
  expect(
    detectDesktopSessionType({
      DISPLAY: ":0",
    }),
  ).toBe("x11");
});

test("detectDesktopSessionType returns unknown when no session hints exist", () => {
  expect(detectDesktopSessionType({})).toBe("unknown");
});
