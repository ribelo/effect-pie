import { Data, Effect } from "effect"

export class NotificationError extends Data.TaggedError("NotificationError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

export const notifyWarning = Effect.fn("pie/desktop/notification.notifyWarning")(
  function* (title: string, message: string): Effect.fn.Return<void, NotificationError> {
    const notifySendPath = Bun.which("notify-send")
    if (notifySendPath === null) {
      return yield* new NotificationError({
        message:
          "notify-send is not available in PATH. Install libnotify to enable desktop notifications.",
      })
    }

    return yield* Effect.tryPromise({
      try: async () => {
        const proc = Bun.spawn([notifySendPath, "--urgency=normal", title, message])
        const code = await proc.exited
        if (code !== 0) {
          throw new NotificationError({
            message: `notify-send exited with code ${code}`,
          })
        }
      },
      catch: (cause) =>
        cause instanceof NotificationError
          ? cause
          : new NotificationError({
              message: `notify-send failed: ${String(cause)}`,
              cause,
            }),
    })
  },
  Effect.tapError((cause) =>
    Effect.logWarning(`Notification failed: ${cause.message}`).pipe(
      Effect.annotateLogs({ cause: cause.cause }),
    ),
  ),
)
