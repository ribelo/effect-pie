import { Effect } from "effect"

export class XdotoolError extends Error {
  readonly stderr: string | undefined

  constructor(message: string, options?: { readonly cause?: unknown; readonly stderr?: string }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = "XdotoolError"
    this.stderr = options?.stderr
  }
}

const readStreamText = async (stream: ReadableStream<Uint8Array> | null): Promise<string> => {
  if (stream === null) {
    return ""
  }

  return await new Response(stream).text()
}

export const buildXdotoolCommandArgs = (xdotoolExecutable: string, text: string): Array<string> => [
  xdotoolExecutable,
  "type",
  "--clearmodifiers",
  "--",
  text,
]

const findXdotoolExecutable = Effect.sync(() => {
  const executable = Bun.which("xdotool")
  if (executable === null) {
    throw new XdotoolError("xdotool is required for X11 text injection but was not found in PATH")
  }

  return executable
})

const validateInputText = (text: string): Effect.Effect<void, XdotoolError> =>
  text.trim().length > 0 ? Effect.void : Effect.fail(new XdotoolError("--text must not be empty"))

export const typeTextWithXdotool = (text: string): Effect.Effect<void, XdotoolError> =>
  Effect.gen(function* () {
    yield* validateInputText(text)
    const xdotoolExecutable = yield* findXdotoolExecutable

    const commandArgs = buildXdotoolCommandArgs(xdotoolExecutable, text)

    yield* Effect.tryPromise({
      try: async () => {
        const process = Bun.spawn(commandArgs, {
          stdout: "pipe",
          stderr: "pipe",
        })

        const [exitCode, stderr] = await Promise.all([
          process.exited,
          readStreamText(process.stderr),
        ])

        if (exitCode !== 0) {
          const details = stderr.trim()
          throw new XdotoolError(
            details.length > 0
              ? `xdotool failed with exit code ${exitCode}: ${details}`
              : `xdotool failed with exit code ${exitCode}`,
            {
              stderr,
            },
          )
        }
      },
      catch: (cause) =>
        cause instanceof XdotoolError
          ? cause
          : new XdotoolError("Failed to execute xdotool", { cause }),
    })
  })
