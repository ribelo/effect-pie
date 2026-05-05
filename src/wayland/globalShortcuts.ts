import * as dbusNext from "dbus-next"
import type { Message as DbusMessage, MessageBus, Variant as DbusVariant } from "dbus-next"
import { Data, Effect } from "effect"

const { Message, MessageType, Variant, sessionBus } = dbusNext

const PORTAL_DESKTOP_SERVICE = "org.freedesktop.portal.Desktop"
const PORTAL_DESKTOP_PATH = "/org/freedesktop/portal/desktop"
const GLOBAL_SHORTCUTS_INTERFACE = "org.freedesktop.portal.GlobalShortcuts"
const SESSION_INTERFACE = "org.freedesktop.portal.Session"
const REQUEST_INTERFACE = "org.freedesktop.portal.Request"
const REQUEST_RESPONSE_TIMEOUT_SECONDS = 30
const DBUS_CONNECT_TIMEOUT_SECONDS = 5

const requestHandlePattern = /^\/org\/freedesktop\/portal\/desktop\/request\/([^/]+)\/[^/]+$/
const objectPathPattern = /\/org\/freedesktop\/portal\/desktop\/[A-Za-z0-9_/-]+/
const requestResponseCodePattern = /\bua\{sv\}\s+(\d+)\b/
const requestResponseSessionHandlePattern =
  /"?session_handle"?\s+[os]\s+"(\/org\/freedesktop\/portal\/desktop\/session\/[A-Za-z0-9_/-]+)"/

type PortalVariantDict = Record<string, DbusVariant<unknown>>

type PortalRequestResponse = {
  readonly requestHandle: string
  readonly responseCode: number
  readonly results: PortalVariantDict
}

export class GlobalShortcutsPortalError extends Data.TaggedError("GlobalShortcutsPortalError")<{
  readonly message: string
  readonly cause?: unknown
  readonly stderr?: string
}> {}

export type PortalShortcutSpec = {
  readonly id: string
  readonly description: string
  readonly preferredTrigger: string
}

export type PortalShortcutSession = {
  readonly shortcut: PortalShortcutSpec
  readonly createRequestHandle: string
  readonly bindRequestHandle: string
  readonly sessionHandle: string
  readonly bus: MessageBus
}

const randomToken = (prefix: string): string => `${prefix}_${crypto.randomUUID()}`

export const parseObjectPathFromBusctlCallOutput = (output: string): string | undefined => {
  const match = output.match(objectPathPattern)
  return match === null ? undefined : match[0]
}

export const deriveSessionHandleFromRequestHandle = (
  requestHandle: string,
  sessionToken: string,
): string | undefined => {
  const match = requestHandle.match(requestHandlePattern)
  if (match === null) {
    return undefined
  }

  const senderId = match[1]
  return `/org/freedesktop/portal/desktop/session/${senderId}/${sessionToken}`
}

export const deriveRequestHandleFromSender = (
  sender: string,
  handleToken: string,
): string | undefined => {
  if (!sender.startsWith(":")) {
    return undefined
  }

  const senderId = sender.slice(1).replaceAll(".", "_")
  return `/org/freedesktop/portal/desktop/request/${senderId}/${handleToken}`
}

export const parseRequestResponseCodeFromBusctlWaitOutput = (
  output: string,
): number | undefined => {
  const match = output.match(requestResponseCodePattern)
  if (match === null) {
    return undefined
  }

  const responseCodeText = match[1]
  if (responseCodeText === undefined) {
    return undefined
  }

  const responseCode = Number.parseInt(responseCodeText, 10)
  return Number.isNaN(responseCode) ? undefined : responseCode
}

export const parseSessionHandleFromRequestResponseOutput = (output: string): string | undefined => {
  const match = output.match(requestResponseSessionHandlePattern)
  return match === null ? undefined : match[1]
}

export const buildCreateSessionOptionsArgs = (tokens: {
  readonly handleToken: string
  readonly sessionHandleToken: string
}): ReadonlyArray<string> => {
  const options = buildCreateSessionOptions(tokens)
  const args: Array<string> = [String(Object.keys(options).length)]
  for (const [key, value] of Object.entries(options)) {
    args.push(key, value.signature, value.value)
  }
  return args
}

export const buildBindShortcutsArgs = (config: {
  readonly sessionHandle: string
  readonly shortcut: PortalShortcutSpec
  readonly parentWindow: string
}): ReadonlyArray<string> => [
  config.sessionHandle,
  "1",
  config.shortcut.id,
  "2",
  "description",
  "s",
  config.shortcut.description,
  "preferred_trigger",
  "s",
  config.shortcut.preferredTrigger,
  config.parentWindow,
  "0",
]

const mapToPortalError = (cause: unknown, fallbackMessage: string): GlobalShortcutsPortalError =>
  cause instanceof GlobalShortcutsPortalError
    ? cause
    : new GlobalShortcutsPortalError({ message: fallbackMessage, cause })

const connectSessionBus = async (): Promise<MessageBus> => {
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
          new GlobalShortcutsPortalError({
            message: `Timed out connecting to session D-Bus after ${DBUS_CONNECT_TIMEOUT_SECONDS} seconds`,
          }),
        )
      })
    }, DBUS_CONNECT_TIMEOUT_SECONDS * 1000)

    bus.on("connect", onConnect)
    bus.on("error", onError)
  })

  return bus
}

const callPortalMethod = async (config: {
  readonly bus: MessageBus
  readonly destination?: string
  readonly path: string
  readonly interfaceName: string
  readonly member: string
  readonly signature?: string
  readonly body?: ReadonlyArray<unknown>
}): Promise<DbusMessage> => {
  const reply = await config.bus.call(
    new Message({
      destination: config.destination ?? PORTAL_DESKTOP_SERVICE,
      path: config.path,
      interface: config.interfaceName,
      member: config.member,
      ...(config.signature === undefined ? {} : { signature: config.signature }),
      body: Array.from(config.body ?? []),
    }),
  )

  if (reply === null) {
    throw new GlobalShortcutsPortalError({
      message: `No reply received for ${config.interfaceName}.${config.member}`,
    })
  }

  if (reply.type === MessageType.ERROR) {
    const errorText =
      reply.body.length > 0 && typeof reply.body[0] === "string"
        ? reply.body[0]
        : "Unknown D-Bus error"

    throw new GlobalShortcutsPortalError({
      message: `${config.interfaceName}.${config.member} failed: ${reply.errorName} :: ${errorText}`,
    })
  }

  if (reply.type !== MessageType.METHOD_RETURN) {
    throw new GlobalShortcutsPortalError({
      message: `${config.interfaceName}.${config.member} returned unexpected D-Bus message type ${reply.type}`,
    })
  }

  return reply
}

const isPortalVariant = (value: unknown): value is DbusVariant<unknown> =>
  typeof value === "object" && value !== null && "signature" in value && "value" in value

const isPortalVariantDict = (value: unknown): value is PortalVariantDict =>
  typeof value === "object" &&
  value !== null &&
  Object.values(value).every((entry) => isPortalVariant(entry))

const parseSessionHandleFromResponseResults = (results: PortalVariantDict): string | undefined => {
  const value = results["session_handle"]
  if (!isPortalVariant(value) || typeof value.value !== "string") {
    return undefined
  }

  return value.value
}

const parseRequestHandleFromMethodReply = (reply: DbusMessage, operation: string): string => {
  const body: ReadonlyArray<unknown> = Array.isArray(reply.body) ? reply.body : []
  const handle = body[0]
  if (
    typeof handle !== "string" ||
    !handle.startsWith("/org/freedesktop/portal/desktop/request/")
  ) {
    throw new GlobalShortcutsPortalError({
      message: `${operation} did not return a valid request handle. Reply body: ${JSON.stringify(reply.body)}`,
    })
  }

  return handle
}

const waitForRequestResponseByHandleToken = (
  bus: MessageBus,
  handleToken: string,
  operation: string,
): {
  readonly promise: Promise<PortalRequestResponse>
  readonly cancel: () => void
} => {
  let done = false
  let timeout: ReturnType<typeof setTimeout> | undefined

  const cleanup = (): void => {
    if (done) {
      return
    }

    done = true
    if (timeout !== undefined) {
      clearTimeout(timeout)
    }
    bus.off("message", onMessage)
  }

  const onMessage = (message: DbusMessage): void => {
    if (done) {
      return
    }

    if (message.type !== MessageType.SIGNAL) {
      return
    }

    if (message.interface !== REQUEST_INTERFACE || message.member !== "Response") {
      return
    }

    if (typeof message.path !== "string" || !message.path.endsWith(`/${handleToken}`)) {
      return
    }

    const body: ReadonlyArray<unknown> = Array.isArray(message.body) ? message.body : []
    const responseCode = body[0]
    const results = body[1]

    if (typeof responseCode !== "number") {
      cleanup()
      rejectPromise(
        new GlobalShortcutsPortalError({
          message: `Could not parse ${operation} response code from portal response body: ${JSON.stringify(message.body)}`,
        }),
      )
      return
    }

    if (!isPortalVariantDict(results)) {
      cleanup()
      rejectPromise(
        new GlobalShortcutsPortalError({
          message: `Could not parse ${operation} response results from portal response body: ${JSON.stringify(message.body)}`,
        }),
      )
      return
    }

    cleanup()
    resolvePromise({
      requestHandle: message.path,
      responseCode,
      results,
    })
  }

  let resolvePromise: (response: PortalRequestResponse) => void = () => undefined
  let rejectPromise: (error: GlobalShortcutsPortalError) => void = () => undefined

  const promise = new Promise<PortalRequestResponse>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject

    timeout = setTimeout(() => {
      cleanup()
      reject(
        new GlobalShortcutsPortalError({
          message:
            `${operation} did not receive a portal response within ${REQUEST_RESPONSE_TIMEOUT_SECONDS} seconds. ` +
            "This usually means xdg-desktop-portal did not emit Request::Response.",
        }),
      )
    }, REQUEST_RESPONSE_TIMEOUT_SECONDS * 1000)

    bus.on("message", onMessage)
  })

  return {
    promise,
    cancel: cleanup,
  }
}

const formatPortalResults = (results: PortalVariantDict): string => {
  const entries = Object.entries(results).map(([key, value]) => {
    if (!isPortalVariant(value)) {
      return `${key}=<non-variant>`
    }

    return `${key}=${value.signature}:${JSON.stringify(value.value)}`
  })

  return entries.length === 0 ? "<empty>" : entries.join(", ")
}

const ensureSuccessfulPortalResponse = (
  response: PortalRequestResponse,
  operation: string,
): void => {
  if (response.responseCode === 0) {
    return
  }

  const reason =
    response.responseCode === 1
      ? "cancelled by user or compositor"
      : response.responseCode === 2
        ? "failed by portal/backend"
        : "returned unexpected status"

  throw new GlobalShortcutsPortalError({
    message: `${operation} was not successful (${reason}, code ${response.responseCode}). Request handle: ${response.requestHandle}. Response results: ${formatPortalResults(response.results)}`,
  })
}

const listDbusNames = async (
  bus: MessageBus,
  member: "ListNames" | "ListActivatableNames",
): Promise<ReadonlyArray<string>> => {
  const reply = await callPortalMethod({
    bus,
    destination: "org.freedesktop.DBus",
    path: "/org/freedesktop/DBus",
    interfaceName: "org.freedesktop.DBus",
    member,
  })

  const body: ReadonlyArray<unknown> = Array.isArray(reply.body) ? reply.body : []
  const names = body[0]
  if (!Array.isArray(names) || !names.every((name) => typeof name === "string")) {
    throw new GlobalShortcutsPortalError({
      message: `Unexpected D-Bus reply shape for ${member}: ${JSON.stringify(reply.body)}`,
    })
  }

  return names
}

const diagnoseBindFailure = async (bus: MessageBus): Promise<string | undefined> => {
  try {
    const [names, activatableNames] = await Promise.all([
      listDbusNames(bus, "ListNames"),
      listDbusNames(bus, "ListActivatableNames"),
    ])

    const hasGnomeImpl = names.includes("org.freedesktop.impl.portal.desktop.gnome")
    const hasProvider =
      names.includes("org.gnome.Settings.GlobalShortcutsProvider") ||
      activatableNames.includes("org.gnome.Settings.GlobalShortcutsProvider")

    if (hasGnomeImpl && !hasProvider) {
      return (
        "Detected GNOME portal backend, but 'org.gnome.Settings.GlobalShortcutsProvider' is unavailable. " +
        "Install the GNOME Control Center global-shortcuts-provider service or switch to a portal backend that supports GlobalShortcuts in your session."
      )
    }
  } catch {
    return undefined
  }

  return undefined
}

const buildCreateSessionOptions = (tokens: {
  readonly handleToken: string
  readonly sessionHandleToken: string
}): Record<string, DbusVariant<string>> => ({
  handle_token: new Variant("s", tokens.handleToken),
  session_handle_token: new Variant("s", tokens.sessionHandleToken),
})

const buildBindShortcutsOptions = (handleToken: string): Record<string, DbusVariant<string>> => ({
  handle_token: new Variant("s", handleToken),
})

const buildPortalShortcutTuple = (
  shortcut: PortalShortcutSpec,
): readonly [string, Record<string, DbusVariant<string>>] => [
  shortcut.id,
  {
    description: new Variant("s", shortcut.description),
    preferred_trigger: new Variant("s", shortcut.preferredTrigger),
  },
]

const findBusctlExecutable = Effect.sync(() => Bun.which("busctl")).pipe(
  Effect.flatMap((executable) =>
    executable === null
      ? Effect.fail(
          new GlobalShortcutsPortalError({
            message: "busctl is required for portal signal monitoring but was not found in PATH",
          }),
        )
      : Effect.succeed(executable),
  ),
)

export const setupGlobalShortcutSession = Effect.fn(
  "pie/wayland/globalShortcuts.setupGlobalShortcutSession",
)(function* (config: {
  readonly shortcut: PortalShortcutSpec
  readonly parentWindow: string
}): Effect.fn.Return<PortalShortcutSession, GlobalShortcutsPortalError> {
  return yield* Effect.tryPromise({
    try: async () => {
      const bus = await connectSessionBus()

      try {
        const createHandleToken = randomToken("pie_create_req")
        const sessionHandleToken = randomToken("pie_session")
        const bindHandleToken = randomToken("pie_bind_req")

        const pendingCreateResponse = waitForRequestResponseByHandleToken(
          bus,
          createHandleToken,
          "CreateSession",
        )

        const createReply = await callPortalMethod({
          bus,
          path: PORTAL_DESKTOP_PATH,
          interfaceName: GLOBAL_SHORTCUTS_INTERFACE,
          member: "CreateSession",
          signature: "a{sv}",
          body: [
            buildCreateSessionOptions({
              handleToken: createHandleToken,
              sessionHandleToken,
            }),
          ],
        }).catch((error: unknown) => {
          pendingCreateResponse.cancel()
          throw error
        })

        const createRequestHandle = parseRequestHandleFromMethodReply(createReply, "CreateSession")
        const createResponse = await pendingCreateResponse.promise
        ensureSuccessfulPortalResponse(createResponse, "CreateSession")

        const sessionHandle =
          parseSessionHandleFromResponseResults(createResponse.results) ??
          deriveSessionHandleFromRequestHandle(createRequestHandle, sessionHandleToken)

        if (sessionHandle === undefined) {
          throw new GlobalShortcutsPortalError({
            message: `Could not determine session handle from CreateSession response for ${createRequestHandle}`,
          })
        }

        const pendingBindResponse = waitForRequestResponseByHandleToken(
          bus,
          bindHandleToken,
          "BindShortcuts",
        )

        const bindReply = await callPortalMethod({
          bus,
          path: PORTAL_DESKTOP_PATH,
          interfaceName: GLOBAL_SHORTCUTS_INTERFACE,
          member: "BindShortcuts",
          signature: "oa(sa{sv})sa{sv}",
          body: [
            sessionHandle,
            [buildPortalShortcutTuple(config.shortcut)],
            config.parentWindow,
            buildBindShortcutsOptions(bindHandleToken),
          ],
        }).catch((error: unknown) => {
          pendingBindResponse.cancel()
          throw error
        })

        const bindRequestHandle = parseRequestHandleFromMethodReply(bindReply, "BindShortcuts")
        const bindResponse = await pendingBindResponse.promise

        if (bindResponse.responseCode !== 0) {
          const diagnostic = await diagnoseBindFailure(bus)
          const suffix = diagnostic === undefined ? "" : ` Hint: ${diagnostic}`
          const reason =
            bindResponse.responseCode === 1
              ? "cancelled by user or compositor"
              : bindResponse.responseCode === 2
                ? "failed by portal/backend"
                : "returned unexpected status"

          throw new GlobalShortcutsPortalError({
            message:
              `BindShortcuts was not successful (${reason}, code ${bindResponse.responseCode}). ` +
              `Request handle: ${bindResponse.requestHandle}. Response results: ${formatPortalResults(bindResponse.results)}.${suffix}`,
          })
        }

        return {
          shortcut: config.shortcut,
          createRequestHandle,
          bindRequestHandle,
          sessionHandle,
          bus,
        }
      } catch (error) {
        bus.disconnect()
        throw error
      }
    },
    catch: (cause) => mapToPortalError(cause, "Failed to set up portal global shortcut session"),
  })
})

export const closeGlobalShortcutSession = Effect.fn(
  "pie/wayland/globalShortcuts.closeGlobalShortcutSession",
)(function* (session: PortalShortcutSession): Effect.fn.Return<void, GlobalShortcutsPortalError> {
  return yield* Effect.tryPromise({
    try: async () => {
      try {
        await callPortalMethod({
          bus: session.bus,
          path: session.sessionHandle,
          interfaceName: SESSION_INTERFACE,
          member: "Close",
        })
      } finally {
        session.bus.disconnect()
      }
    },
    catch: (cause) => mapToPortalError(cause, "Failed to close portal global shortcut session"),
  })
})

export const monitorPortalSignals = Effect.fn("pie/wayland/globalShortcuts.monitorPortalSignals")(
  function* (): Effect.fn.Return<void> {
    yield* Effect.scoped(
      Effect.gen(function* () {
        const busctlExecutable = yield* findBusctlExecutable

        const monitor = yield* Effect.acquireRelease(
          Effect.sync(() =>
            Bun.spawn(
              [busctlExecutable, "--user", "--no-pager", "monitor", PORTAL_DESKTOP_SERVICE],
              {
                stdout: "inherit",
                stderr: "inherit",
              },
            ),
          ),
          (process) =>
            Effect.sync(() => {
              process.kill()
            }).pipe(
              Effect.tapError((cause) =>
                Effect.logWarning("Failed to kill busctl monitor process").pipe(
                  Effect.annotateLogs({ cause }),
                ),
              ),
              Effect.ignore,
            ),
        )

        const exitCode = yield* Effect.tryPromise({
          try: () => monitor.exited,
          catch: (cause) =>
            new GlobalShortcutsPortalError({
              message: "busctl monitor process exited abnormally",
              cause,
            }),
        })

        yield* Effect.logWarning("busctl monitor exited unexpectedly").pipe(
          Effect.annotateLogs({ exitCode }),
        )
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Portal signal monitor failed").pipe(Effect.annotateLogs({ cause })),
        ),
      ),
    )
  },
)
