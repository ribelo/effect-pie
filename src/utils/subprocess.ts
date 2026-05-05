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
