import { Data, Effect } from "effect";

import { detectDesktopSessionType, type DesktopSessionType } from "../desktop/session.js";
import { typeTextWithWtype, WtypeError } from "../wayland/wtype.js";
import { typeTextWithXdotool, XdotoolError } from "../x11/xdotool.js";

export type TextInjectionBackend = "wtype" | "xdotool";

export type TextInjectionResult = {
  readonly sessionType: DesktopSessionType;
  readonly backend: TextInjectionBackend;
  readonly text: string;
};

export class TextInjectionError extends Data.TaggedError("TextInjectionError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

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

export const normalizeTextForInjection = (text: string): string =>
  text
    .replace(/\r\n/g, "\n")
    .replace(/[\r\n\u2028\u2029]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

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
    const normalizedText = normalizeTextForInjection(text);
    if (normalizedText.length === 0) {
      return yield* new TextInjectionError({
        message: "No text to inject after normalization",
      });
    }

    const sessionType = detectDesktopSessionType();
    const primaryBackend = chooseTextInjectionBackend(sessionType);

    if (primaryBackend === undefined) {
      return yield* new TextInjectionError({
        message:
          "Could not detect graphical session. Set XDG_SESSION_TYPE or ensure WAYLAND_DISPLAY/DISPLAY is available.",
      });
    }

    const fallbackBackend = chooseFallbackTextInjectionBackend(primaryBackend);

    const resolvedBackend = yield* runTextInjectionBackend(primaryBackend, normalizedText).pipe(
      Effect.as(primaryBackend),
      Effect.catchIf(
        (_error): _error is WtypeError | XdotoolError => true,
        (error) => {
          if (fallbackBackend === undefined || !isRecoverableBackendError(error)) {
            return Effect.fail(error);
          }

          return runTextInjectionBackend(fallbackBackend, normalizedText).pipe(
            Effect.as(fallbackBackend),
          );
        },
      ),
    );

    return {
      sessionType,
      backend: resolvedBackend,
      text: normalizedText,
    };
  });
