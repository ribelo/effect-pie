import { Data, Effect } from "effect"

import { detectDesktopSessionType, type DesktopSessionType } from "../desktop/session.js"
import { typeTextWithWtype, type WtypeError } from "../wayland/wtype.js"
import { typeTextWithXdotool, type XdotoolError } from "../x11/xdotool.js"

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
    .replace(/[\r\n\u2028\u2029]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()

const runTextInjectionBackend = (
  backend: TextInjectionBackend,
  text: string,
): Effect.Effect<void, WtypeError | XdotoolError> =>
  backend === "wtype" ? typeTextWithWtype(text) : typeTextWithXdotool(text)

export const typeTextInFocusedApp = Effect.fn("pie/input/textInjection.typeTextInFocusedApp")(
  function* (
    text: string,
  ): Effect.fn.Return<TextInjectionResult, TextInjectionError | WtypeError | XdotoolError> {
    const normalizedText = normalizeTextForInjection(text)
    if (normalizedText.length === 0) {
      return yield* new TextInjectionError({
        message: "No text to inject after normalization",
      })
    }

    const sessionType = detectDesktopSessionType()
    const primaryBackend = yield* chooseTextInjectionBackend(sessionType)

    const resolvedBackend = yield* runTextInjectionBackend(primaryBackend, normalizedText).pipe(
      Effect.as(primaryBackend),
    )

    return {
      sessionType,
      backend: resolvedBackend,
      text: normalizedText,
    }
  },
)
