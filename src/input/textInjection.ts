import { Effect } from "effect";

import { detectDesktopSessionType, type DesktopSessionType } from "../desktop/session.js";
import { typeTextWithWtype, WtypeError } from "../wayland/wtype.js";
import { typeTextWithXdotool, XdotoolError } from "../x11/xdotool.js";

export type TextInjectionBackend = "wtype" | "xdotool";

export type TextInjectionResult = {
  readonly sessionType: DesktopSessionType;
  readonly backend: TextInjectionBackend;
};

export class TextInjectionError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "TextInjectionError";
  }
}

export const chooseTextInjectionBackend = (
  sessionType: DesktopSessionType,
): TextInjectionBackend | undefined => {
  if (sessionType === "wayland") {
    return "wtype";
  }

  if (sessionType === "x11") {
    return "xdotool";
  }

  return undefined;
};

export const chooseFallbackTextInjectionBackend = (
  primaryBackend: TextInjectionBackend,
  env: NodeJS.ProcessEnv = process.env,
): TextInjectionBackend | undefined => {
  const hasWayland = (env.WAYLAND_DISPLAY ?? "").trim().length > 0;
  const hasX11 = (env.DISPLAY ?? "").trim().length > 0;

  if (primaryBackend === "wtype" && hasX11) {
    return "xdotool";
  }

  if (primaryBackend === "xdotool" && hasWayland) {
    return "wtype";
  }

  return undefined;
};

const runTextInjectionBackend = (
  backend: TextInjectionBackend,
  text: string,
): Effect.Effect<void, WtypeError | XdotoolError> =>
  backend === "wtype" ? typeTextWithWtype(text) : typeTextWithXdotool(text);

const isRecoverableBackendError = (error: WtypeError | XdotoolError): boolean => {
  if (error instanceof WtypeError) {
    return (
      error.message.includes("was not found in PATH") ||
      error.message.toLowerCase().includes("wayland connection failed")
    );
  }

  return (
    error.message.includes("was not found in PATH") ||
    error.message.toLowerCase().includes("can't open display")
  );
};

export const typeTextInFocusedApp = (
  text: string,
): Effect.Effect<TextInjectionResult, TextInjectionError | WtypeError | XdotoolError> =>
  Effect.gen(function* () {
    const sessionType = detectDesktopSessionType();
    const primaryBackend = chooseTextInjectionBackend(sessionType);

    if (primaryBackend === undefined) {
      return yield* Effect.fail(
        new TextInjectionError(
          "Could not detect graphical session. Set XDG_SESSION_TYPE or ensure WAYLAND_DISPLAY/DISPLAY is available.",
        ),
      );
    }

    const fallbackBackend = chooseFallbackTextInjectionBackend(primaryBackend);

    const resolvedBackend = yield* runTextInjectionBackend(primaryBackend, text).pipe(
      Effect.as(primaryBackend),
      Effect.catchIf(
        (_error): _error is WtypeError | XdotoolError => true,
        (error) => {
          if (fallbackBackend === undefined || !isRecoverableBackendError(error)) {
            return Effect.fail(error);
          }

          return runTextInjectionBackend(fallbackBackend, text).pipe(Effect.as(fallbackBackend));
        },
      ),
    );

    return {
      sessionType,
      backend: resolvedBackend,
    };
  });
