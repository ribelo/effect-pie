import { Data, Effect } from "effect"

import { runExternalTool } from "../utils/subprocess.js"

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

    yield* runExternalTool({
      command: [notifySendPath, "--urgency=normal", title, message],
      timeoutMs: 5_000,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new NotificationError({
            message: cause.message.replace("Subprocess", "notify-send"),
            cause,
          }),
      ),
      Effect.asVoid,
    )
  },
  Effect.tapError((cause) =>
    Effect.logWarning(`Notification failed: ${cause.message}`).pipe(
      Effect.annotateLogs({ cause: cause.cause }),
    ),
  ),
)
