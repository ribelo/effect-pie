import * as dbusNext from "dbus-next"
import type { MessageBus } from "dbus-next"
import { Data, Effect } from "effect"

const { sessionBus } = dbusNext

export class DbusConnectionError extends Data.TaggedError("DbusConnectionError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

export const connectDbusSessionBus = (config: {
  readonly timeoutMs: number
  readonly errorMessage: string
}): Effect.Effect<MessageBus, DbusConnectionError> =>
  Effect.tryPromise({
    try: async () => {
      const bus = sessionBus()

      await new Promise<void>((resolve, reject) => {
        let finished = false

        const finish = (callback: () => void): void => {
          if (finished) {
            return
          }

          finished = true
          bus.off("connect", onConnect)
          bus.off("error", onError)
          clearTimeout(timeout)
          callback()
        }

        const onConnect = (): void => {
          finish(resolve)
        }

        const onError = (error: unknown): void => {
          finish(() => {
            reject(error)
          })
        }

        const timeout = setTimeout(() => {
          finish(() => {
            reject(
              new DbusConnectionError({
                message: `${config.errorMessage} after ${config.timeoutMs}ms`,
              }),
            )
          })
        }, config.timeoutMs)

        bus.on("connect", onConnect)
        bus.on("error", onError)
      })

      return bus
    },
    catch: (cause) =>
      cause instanceof DbusConnectionError
        ? cause
        : new DbusConnectionError({
            message: config.errorMessage,
            cause,
          }),
  })
