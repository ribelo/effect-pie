import * as dbusNext from "dbus-next"
import type { MessageBus, Message as DbusMessage } from "dbus-next"
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Queue from "effect/Queue"
import type * as Scope from "effect/Scope"

const { Message, MessageType, sessionBus } = dbusNext

const A11Y_MANAGER_SERVICE = "org.freedesktop.a11y.Manager"
const A11Y_MANAGER_PATH = "/org/freedesktop/a11y/Manager"
const A11Y_KEYBOARD_INTERFACE = "org.freedesktop.a11y.KeyboardMonitor"
const A11Y_DBUS_CONNECT_TIMEOUT_MS = 5000

export type KeyboardMonitorKeyEvent = {
  readonly released: boolean
  readonly state: number
  readonly keysym: number
  readonly unichar: number
  readonly keycode: number
}

export class PttKeyboardError extends Data.TaggedError("PttKeyboardError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

export class KeyboardMonitorService extends Context.Service<
  KeyboardMonitorService,
  {
    readonly subscribe: Effect.Effect<Queue.Queue<KeyboardMonitorKeyEvent>, never, Scope.Scope>
  }
>()("pie/keyboard/KeyboardMonitorService") {}

const make = Effect.gen(function* () {
  const bus = yield* connectKeyboardMonitorBus()

  yield* Effect.addFinalizer(() => Effect.sync(() => bus.disconnect()).pipe(Effect.ignore))

  yield* callKeyboardMonitorMethod(bus, "WatchKeyboard")
  yield* Effect.addFinalizer(() =>
    callKeyboardMonitorMethod(bus, "UnwatchKeyboard").pipe(Effect.ignore),
  )

  const subscribers = new Set<Queue.Queue<KeyboardMonitorKeyEvent>>()

  const onMessage = (message: DbusMessage): void => {
    const event = parseKeyboardMonitorSignal(message)
    if (event === undefined) {
      return
    }

    for (const queue of subscribers) {
      Queue.offerUnsafe(queue, event)
    }
  }

  bus.on("message", onMessage)
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => bus.off("message", onMessage)).pipe(Effect.ignore),
  )

  const subscribe = Effect.gen(function* () {
    const queue = yield* Queue.unbounded<KeyboardMonitorKeyEvent>()

    subscribers.add(queue)

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        subscribers.delete(queue)
      }),
    )

    return queue
  })

  return { subscribe }
})

export const layer: Layer.Layer<KeyboardMonitorService> = Layer.effect(KeyboardMonitorService)(
  Effect.orDie(make),
)

const connectKeyboardMonitorBus = (): Effect.Effect<MessageBus, PttKeyboardError> =>
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
              new PttKeyboardError({
                message: `Timed out connecting to session D-Bus after ${A11Y_DBUS_CONNECT_TIMEOUT_MS} ms`,
              }),
            )
          })
        }, A11Y_DBUS_CONNECT_TIMEOUT_MS)

        bus.on("connect", onConnect)
        bus.on("error", onError)

        const sender = (bus as MessageBus & { readonly name?: unknown }).name
        if (typeof sender === "string" && sender.length > 0) {
          finish(resolve)
        }
      })

      return bus
    },
    catch: (cause) =>
      cause instanceof PttKeyboardError
        ? cause
        : new PttKeyboardError({ message: "Failed to connect to session D-Bus", cause }),
  })

const callKeyboardMonitorMethod = (
  bus: MessageBus,
  member: "WatchKeyboard" | "UnwatchKeyboard",
): Effect.Effect<void, PttKeyboardError> =>
  Effect.tryPromise({
    try: async () => {
      const reply = await bus.call(
        new Message({
          destination: A11Y_MANAGER_SERVICE,
          path: A11Y_MANAGER_PATH,
          interface: A11Y_KEYBOARD_INTERFACE,
          member,
        }),
      )

      if (reply === null) {
        throw new PttKeyboardError({ message: `No D-Bus reply received for ${member}` })
      }

      if (reply.type === MessageType.ERROR) {
        const detail =
          reply.body.length > 0 && typeof reply.body[0] === "string"
            ? reply.body[0]
            : "Unknown D-Bus error"
        throw new PttKeyboardError({
          message: `${member} failed: ${reply.errorName ?? "<unknown>"} :: ${detail}`,
        })
      }

      if (reply.type !== MessageType.METHOD_RETURN) {
        throw new PttKeyboardError({
          message: `${member} returned unexpected D-Bus message type ${reply.type}`,
        })
      }
    },
    catch: (cause) =>
      cause instanceof PttKeyboardError
        ? cause
        : new PttKeyboardError({ message: `Failed to call ${member}`, cause }),
  })

const parseKeyboardMonitorSignal = (message: DbusMessage): KeyboardMonitorKeyEvent | undefined => {
  if (message.type !== MessageType.SIGNAL) {
    return undefined
  }

  if (
    message.interface !== A11Y_KEYBOARD_INTERFACE ||
    message.member !== "KeyEvent" ||
    message.body.length < 5
  ) {
    return undefined
  }

  const body: ReadonlyArray<unknown> = Array.isArray(message.body) ? message.body : []
  const [released, state, keysym, unichar, keycode] = body

  if (
    typeof released !== "boolean" ||
    typeof state !== "number" ||
    typeof keysym !== "number" ||
    typeof unichar !== "number" ||
    typeof keycode !== "number"
  ) {
    return undefined
  }

  return {
    released,
    state,
    keysym,
    unichar,
    keycode,
  }
}
