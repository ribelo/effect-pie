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

export const findExecutable = (config: {
  readonly name: string
  readonly missingMessage: string
}): Effect.Effect<string, SubprocessError> =>
  Effect.try({
    try: () => Bun.which(config.name),
    catch: (cause) =>
      new SubprocessError({
        message: `Failed to resolve executable '${config.name}'`,
        cause,
      }),
  }).pipe(
    Effect.flatMap((executable) =>
      executable === null
        ? Effect.fail(new SubprocessError({ message: config.missingMessage }))
        : Effect.succeed(executable),
    ),
  )

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

export const runLongRunningExternalTool = (config: {
  readonly command: ReadonlyArray<string>
  readonly stdout?: "inherit" | "ignore" | "pipe"
  readonly stderr?: "inherit" | "ignore" | "pipe"
}): Effect.Effect<{ readonly exitCode: number }, SubprocessError> =>
  Effect.scoped(
    Effect.gen(function* () {
      const process = yield* Effect.acquireRelease(
        Effect.try({
          try: () =>
            Bun.spawn(Array.from(config.command), {
              stdout: config.stdout ?? "inherit",
              stderr: config.stderr ?? "inherit",
            }),
          catch: (cause) =>
            new SubprocessError({
              message: `Failed to start subprocess: ${config.command.join(" ")}`,
              cause,
            }),
        }),
        (process) =>
          Effect.sync(() => {
            try {
              process.kill()
            } catch {
              return
            }
          }),
      )

      const exitCode = yield* Effect.tryPromise({
        try: () => process.exited,
        catch: (cause) =>
          new SubprocessError({
            message: `Subprocess failed while waiting for exit: ${config.command.join(" ")}`,
            cause,
          }),
      })

      return { exitCode }
    }),
  )
