import { Console, Effect } from "effect"

export const notifyWarning = (title: string, message: string): Effect.Effect<void> =>
  Effect.tryPromise({
    try: async () => {
      const proc = Bun.spawn(["notify-send", "--urgency=normal", title, message])
      const code = await proc.exited
      if (code !== 0) {
        throw new Error(`notify-send exited with code ${code}`)
      }
    },
    catch: (cause) =>
      cause instanceof Error ? cause : new Error(`notify-send failed: ${String(cause)}`),
  }).pipe(
    Effect.tapError((cause) =>
      Console.log(`Notification failed: ${cause instanceof Error ? cause.message : String(cause)}`),
    ),
    Effect.catch(() => Effect.void),
  )
