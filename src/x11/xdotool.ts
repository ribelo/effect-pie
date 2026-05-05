import { Data, Effect } from "effect"
import { readStreamText } from "../utils/subprocess.js"

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

  yield* Effect.tryPromise({
    try: async () => {
      const process = Bun.spawn(commandArgs, {
        stdout: "pipe",
        stderr: "pipe",
      })

      let timeout: ReturnType<typeof setTimeout> | undefined

      try {
        const [exitCode, _stdout, stderr] = await Promise.race([
          Promise.all([
            process.exited,
            Effect.runPromise(readStreamText(process.stdout)),
            Effect.runPromise(readStreamText(process.stderr)),
          ]),
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => {
              try {
                process.kill()
              } catch {
                // ignore
              }
              reject(
                new XdotoolError({
                  message: "xdotool timed out after 30000ms",
                }),
              )
            }, 30_000)
          }),
        ])

        if (exitCode !== 0) {
          const details = stderr.trim()
          throw new XdotoolError({
            message:
              details.length > 0
                ? `xdotool failed with exit code ${exitCode}: ${details}`
                : `xdotool failed with exit code ${exitCode}`,
            stderr,
          })
        }
      } finally {
        if (timeout !== undefined) {
          clearTimeout(timeout)
        }
      }
    },
    catch: (cause) =>
      cause instanceof XdotoolError
        ? cause
        : new XdotoolError({ message: "Failed to execute xdotool", cause }),
  })
})
