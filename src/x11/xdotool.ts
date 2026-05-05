import { Data, Effect } from "effect"

import { runExternalTool } from "../utils/subprocess.js"

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

const findXdotoolExecutable = Effect.sync(() => Bun.which("xdotool")).pipe(
  Effect.flatMap((executable) =>
    executable === null
      ? Effect.fail(
          new XdotoolError({
            message: "xdotool is required for X11 text injection but was not found in PATH",
          }),
        )
      : Effect.succeed(executable),
  ),
)

export const typeTextWithXdotool = Effect.fn("pie/x11/xdotool.typeTextWithXdotool")(function* (
  text: string,
): Effect.fn.Return<void, XdotoolError> {
  const xdotoolExecutable = yield* findXdotoolExecutable

  const commandArgs = buildXdotoolCommandArgs(xdotoolExecutable, text)

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
