import { Data, Effect } from "effect"

import {
  DesktopSession,
  type DesktopSessionType,
  type SessionDetectionError,
} from "../desktop/session.js"
import { typeTextWithWtype } from "../wayland/wtype.js"
import { typeTextWithXdotool } from "../x11/xdotool.js"

export type TextInjectionBackend = "wtype" | "xdotool"

export type TextInjectionResult = {
  readonly sessionType: DesktopSessionType
  readonly backend: TextInjectionBackend
  readonly text: string
}

export class TextInjectionError extends Data.TaggedError("TextInjectionError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

export const chooseTextInjectionBackend = (
  sessionType: DesktopSessionType,
): Effect.Effect<TextInjectionBackend, TextInjectionError> => {
  if (sessionType === "wayland") {
    return Effect.succeed("wtype")
  }

  if (sessionType === "x11") {
    return Effect.succeed("xdotool")
  }

  return Effect.fail(
    new TextInjectionError({
      message:
        "Could not detect graphical session. Set XDG_SESSION_TYPE or ensure WAYLAND_DISPLAY/DISPLAY is available.",
    }),
  )
}

export const normalizeTextForInjection = (text: string): string =>
  text
    .replace(/\r\n/g, "\n")
    .replace(/[\r\u2028\u2029]/g, "\n")
    .trim()

const runTextInjectionBackend = (
  backend: TextInjectionBackend,
  text: string,
): Effect.Effect<void, TextInjectionError> => {
  if (backend === "wtype") {
    return typeTextWithWtype(text).pipe(
      Effect.mapError(
        (cause) =>
          new TextInjectionError({
            message: `${backend} text injection failed`,
            cause,
          }),
      ),
    )
  }

  return typeTextWithXdotool(text).pipe(
    Effect.mapError(
      (cause) =>
        new TextInjectionError({
          message: `${backend} text injection failed`,
          cause,
        }),
    ),
  )
}

export const typeTextInFocusedApp = Effect.fn("pie/input/textInjection.typeTextInFocusedApp")(
  function* (
    text: string,
  ): Effect.fn.Return<
    TextInjectionResult,
    TextInjectionError | SessionDetectionError,
    DesktopSession
  > {
    const normalizedText = normalizeTextForInjection(text)
    if (normalizedText.length === 0) {
      return yield* new TextInjectionError({
        message: "No text to inject after normalization",
      })
    }

    const desktopSession = yield* Effect.service(DesktopSession)
    const sessionType = yield* desktopSession.detect
    const primaryBackend = yield* chooseTextInjectionBackend(sessionType)

    yield* runTextInjectionBackend(primaryBackend, normalizedText)

    const resolvedBackend = primaryBackend

    return {
      sessionType,
      backend: resolvedBackend,
      text: normalizedText,
    }
  },
)
