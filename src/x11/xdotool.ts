import { Data, Effect } from "effect"

import { normalizeTextForTypingBackend } from "../input/textNormalization.js"
import { findExecutable, runExternalTool } from "../utils/subprocess.js"

export class XdotoolError extends Data.TaggedError("XdotoolError")<{
  readonly message: string
  readonly cause?: unknown
  readonly stderr?: string
}> {}

const buildXdotoolCommandArgs = (xdotoolExecutable: string, text: string): Array<string> => [
  xdotoolExecutable,
  "type",
  "--clearmodifiers",
  "--",
  text,
]

const findXdotoolExecutable = findExecutable({
  name: "xdotool",
  missingMessage: "xdotool is required for X11 text injection but was not found in PATH",
}).pipe(
  Effect.mapError(
    (cause) =>
      new XdotoolError({
        message: cause.message,
        cause,
      }),
  ),
)

export const typeTextWithXdotool = Effect.fn("pie/x11/xdotool.typeTextWithXdotool")(function* (
  text: string,
): Effect.fn.Return<void, XdotoolError> {
  const normalizedText = normalizeTextForTypingBackend(text)
  if (normalizedText.length === 0) {
    return
  }

  yield* Effect.annotateCurrentSpan({
    "injection.chars": normalizedText.length,
  })

  const xdotoolExecutable = yield* findXdotoolExecutable

  const commandArgs = buildXdotoolCommandArgs(xdotoolExecutable, normalizedText)

  yield* runExternalTool({ command: commandArgs, timeoutMs: 30_000 }).pipe(
    Effect.mapError(
      (cause) =>
        new XdotoolError({
          message: cause.message.replace("Subprocess", "xdotool"),
          cause,
        }),
    ),
    Effect.asVoid,
  )
})
