import * as Context from "effect/Context"
import { Data, Effect } from "effect"
import * as Layer from "effect/Layer"

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

export class TextInjectionBackendService extends Context.Service<
  TextInjectionBackendService,
  {
    readonly backend: TextInjectionBackend
    readonly typeText: (text: string) => Effect.Effect<void, TextInjectionError>
  }
>()("pie/input/TextInjectionBackendService") {}

const waylandBackend = TextInjectionBackendService.of({
  backend: "wtype",
  typeText: (text) =>
    typeTextWithWtype(text).pipe(
      Effect.mapError(
        (cause) =>
          new TextInjectionError({
            message: "wtype text injection failed",
            cause,
          }),
      ),
    ),
})

const x11Backend = TextInjectionBackendService.of({
  backend: "xdotool",
  typeText: (text) =>
    typeTextWithXdotool(text).pipe(
      Effect.mapError(
        (cause) =>
          new TextInjectionError({
            message: "xdotool text injection failed",
            cause,
          }),
      ),
    ),
})

export const WaylandTextInjectionLive = Layer.succeed(TextInjectionBackendService, waylandBackend)

export const X11TextInjectionLive = Layer.succeed(TextInjectionBackendService, x11Backend)

export const TextInjectionBackendLive = Layer.effect(
  TextInjectionBackendService,
  Effect.gen(function* () {
    const desktopSession = yield* Effect.service(DesktopSession)
    const sessionType = yield* desktopSession.detect
    const backend = yield* chooseTextInjectionBackend(sessionType)

    if (backend === "wtype") {
      return waylandBackend
    }

    return x11Backend
  }),
)

export const typeTextInFocusedApp = Effect.fn("pie/input/textInjection.typeTextInFocusedApp")(
  function* (
    text: string,
  ): Effect.fn.Return<
    TextInjectionResult,
    TextInjectionError | SessionDetectionError,
    DesktopSession | TextInjectionBackendService
  > {
    const normalizedText = normalizeTextForInjection(text)
    if (normalizedText.length === 0) {
      return yield* new TextInjectionError({
        message: "No text to inject after normalization",
      })
    }

    const desktopSession = yield* Effect.service(DesktopSession)
    const sessionType = yield* desktopSession.detect

    const backend = yield* Effect.service(TextInjectionBackendService)
    yield* backend.typeText(normalizedText)

    return {
      sessionType,
      backend: backend.backend,
      text: normalizedText,
    }
  },
)
