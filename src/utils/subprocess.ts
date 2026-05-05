import { Data, Effect } from "effect"

export class SubprocessError extends Data.TaggedError("SubprocessError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

export const readStreamText = (
  stream: ReadableStream<Uint8Array> | null,
): Effect.Effect<string, SubprocessError> => {
  if (stream === null) {
    return Effect.succeed("")
  }

  return Effect.tryPromise({
    try: async () => await new Response(stream).text(),
    catch: (cause) => new SubprocessError({ message: "Failed to read subprocess stream", cause }),
  })
}

export const runExternalTool = (config: {
  readonly command: ReadonlyArray<string>
  readonly timeoutMs?: number
  readonly checkExitCode?: boolean
}): Effect.Effect<
  { readonly stdout: string; readonly stderr: string; readonly exitCode: number },
  SubprocessError
> =>
  Effect.tryPromise({
    try: async () => {
      const process = Bun.spawn(Array.from(config.command), {
        stdout: "pipe",
        stderr: "pipe",
      })

      const timeoutMs = config.timeoutMs ?? 30_000
      const checkExitCode = config.checkExitCode ?? true

      let timeout: ReturnType<typeof setTimeout> | undefined

      try {
        const [exitCode, stdout, stderr] = await Promise.race([
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
                new SubprocessError({
                  message: `Subprocess timed out after ${timeoutMs}ms: ${config.command.join(" ")}`,
                }),
              )
            }, timeoutMs)
          }),
        ])

        if (checkExitCode && exitCode !== 0) {
          const details = stderr.trim()
          throw new SubprocessError({
            message:
              details.length > 0
                ? `Subprocess exited with code ${exitCode}: ${details}`
                : `Subprocess exited with code ${exitCode}: ${config.command.join(" ")}`,
            cause: { exitCode, stderr },
          })
        }

        return { stdout, stderr, exitCode }
      } finally {
        if (timeout !== undefined) {
          clearTimeout(timeout)
        }
      }
    },
    catch: (cause) =>
      cause instanceof SubprocessError
        ? cause
        : new SubprocessError({
            message: `Subprocess failed: ${config.command.join(" ")}`,
            cause,
          }),
  })
