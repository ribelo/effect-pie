import { Effect } from "effect"
import { readStreamText } from "../utils/subprocess.js"

export class WtypeError extends Error {
  readonly stderr: string | undefined

  constructor(message: string, options?: { readonly cause?: unknown; readonly stderr?: string }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = "WtypeError"
    this.stderr = options?.stderr
  }
}
const DEFAULT_DIRECT_COMMAND_TIMEOUT_MS = 30_000
const DEFAULT_CLIPBOARD_COMMAND_TIMEOUT_MS = 2_000
const MAX_COMMAND_TIMEOUT_MS = 2_147_483_647

const runCommand = (
  commandArgs: Array<string>,
  executableName: string,
  timeoutMs: number,
): Effect.Effect<{ readonly stdout: string; readonly stderr: string }, WtypeError> =>
  Effect.tryPromise({
    try: async () => {
      const process = Bun.spawn(commandArgs, {
        stdout: "pipe",
        stderr: "pipe",
      })

      let timeout: ReturnType<typeof setTimeout> | undefined

      try {
        const [exitCode, stdout, stderr] = await Promise.race([
          Promise.all([
            process.exited,
            readStreamText(process.stdout),
            readStreamText(process.stderr),
          ]),
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => {
              try {
                process.kill()
              } finally {
                reject(new WtypeError(`${executableName} timed out after ${timeoutMs}ms`))
              }
            }, timeoutMs)
          }),
        ])

        if (exitCode !== 0) {
          const details = stderr.trim()
          throw new WtypeError(
            details.length > 0
              ? `${executableName} failed with exit code ${exitCode}: ${details}`
              : `${executableName} failed with exit code ${exitCode}`,
            {
              stderr,
            },
          )
        }

        return {
          stdout,
          stderr,
        }
      } finally {
        if (timeout !== undefined) {
          clearTimeout(timeout)
        }
      }
    },
    catch: (cause) =>
      cause instanceof WtypeError
        ? cause
        : new WtypeError(`Failed to execute ${executableName}`, { cause }),
  })

export const buildWtypeCommandArgs = (
  wtypeExecutable: string,
  text: string,
  delayMs = 0,
): Array<string> =>
  delayMs > 0 ? [wtypeExecutable, "-d", String(delayMs), "--", text] : [wtypeExecutable, "--", text]

export const buildWtypePasteShortcutArgs = (wtypeExecutable: string): Array<string> => [
  wtypeExecutable,
  "-M",
  "ctrl",
  "-k",
  "v",
  "-m",
  "ctrl",
]

const buildWlCopyCommandArgs = (wlCopyExecutable: string, text: string): Array<string> => [
  wlCopyExecutable,
  "-n",
  "-t",
  "text/plain;charset=utf-8",
  "--",
  text,
]

const buildWlPasteCommandArgs = (wlPasteExecutable: string): Array<string> => [
  wlPasteExecutable,
  "-n",
]

export const shouldUseWtypeClipboardPaste = (text: string): boolean =>
  /['"`\u2018\u2019]/u.test(text)

export type WtypeInjectionMode = "direct" | "clipboard" | "auto"

export const resolveWtypeInjectionMode = (
  env: NodeJS.ProcessEnv = process.env,
): WtypeInjectionMode => {
  const rawMode = (
    env["PIE_WAYLAND_INJECTION_MODE"] ??
    env["EFFECT_PI_WAYLAND_INJECTION_MODE"] ??
    "auto"
  )
    .trim()
    .toLowerCase()

  if (rawMode === "direct" || rawMode === "clipboard" || rawMode === "auto") {
    return rawMode
  }

  return "auto"
}

const shouldAttemptClipboardPaste = (mode: WtypeInjectionMode, text: string): boolean => {
  if (mode === "clipboard") {
    return true
  }

  if (mode === "direct") {
    return false
  }

  return shouldUseWtypeClipboardPaste(text)
}

const findWtypeExecutable = Effect.try({
  try: () => {
    const executable = Bun.which("wtype")
    if (executable === null) {
      throw new WtypeError("wtype is required but was not found in PATH")
    }

    return executable
  },
  catch: (cause) =>
    cause instanceof WtypeError ? cause : new WtypeError("Failed to resolve wtype", { cause }),
})

const findOptionalWlCopyExecutable = (): string | undefined => Bun.which("wl-copy") ?? undefined

const findOptionalWlPasteExecutable = (): string | undefined => Bun.which("wl-paste") ?? undefined

const typeTextWithWtypeDirect = (
  wtypeExecutable: string,
  text: string,
  commandTimeoutMs: number,
): Effect.Effect<void, WtypeError> => {
  const delayMs = Array.from(text).some((char) => char.charCodeAt(0) > 127) ? 8 : 0
  const commandArgs = buildWtypeCommandArgs(wtypeExecutable, text, delayMs)

  return runCommand(commandArgs, "wtype", commandTimeoutMs).pipe(Effect.asVoid)
}

const readClipboardText = (
  wlPasteExecutable: string | undefined,
  commandTimeoutMs: number,
): Effect.Effect<string | undefined> => {
  if (wlPasteExecutable === undefined) {
    return Effect.as(Effect.void, undefined)
  }

  return runCommand(buildWlPasteCommandArgs(wlPasteExecutable), "wl-paste", commandTimeoutMs).pipe(
    Effect.map(({ stdout }) => stdout),
    Effect.catch(() => Effect.as(Effect.void, undefined)),
  )
}

const typeTextWithWtypeClipboardPaste = (config: {
  readonly wtypeExecutable: string
  readonly wlCopyExecutable: string
  readonly previousClipboard: string | undefined
  readonly text: string
  readonly commandTimeoutMs: number
}): Effect.Effect<void, WtypeError> =>
  Effect.gen(function* () {
    yield* runCommand(
      buildWlCopyCommandArgs(config.wlCopyExecutable, config.text),
      "wl-copy",
      config.commandTimeoutMs,
    )
    yield* runCommand(
      buildWtypePasteShortcutArgs(config.wtypeExecutable),
      "wtype",
      config.commandTimeoutMs,
    )

    if (config.previousClipboard === undefined) {
      return
    }

    yield* runCommand(
      buildWlCopyCommandArgs(config.wlCopyExecutable, config.previousClipboard),
      "wl-copy",
      config.commandTimeoutMs,
    ).pipe(Effect.catch(() => Effect.void))
  })

const resolveCommandTimeoutMs = (
  value: number | undefined,
  defaultValue: number,
): Effect.Effect<number, WtypeError> => {
  if (value === undefined) {
    return Effect.succeed(defaultValue)
  }

  return Number.isFinite(value) && value > 0 && value <= MAX_COMMAND_TIMEOUT_MS
    ? Effect.succeed(value)
    : Effect.fail(
        new WtypeError(
          `commandTimeoutMs must be a positive number up to ${MAX_COMMAND_TIMEOUT_MS}`,
        ),
      )
}

export const typeTextWithWtype = (
  text: string,
  options?: {
    readonly mode?: WtypeInjectionMode
    readonly commandTimeoutMs?: number
  },
): Effect.Effect<void, WtypeError> =>
  Effect.gen(function* () {
    const wtypeExecutable = yield* findWtypeExecutable
    const mode = options?.mode ?? resolveWtypeInjectionMode()
    const directCommandTimeoutMs = yield* resolveCommandTimeoutMs(
      options?.commandTimeoutMs,
      DEFAULT_DIRECT_COMMAND_TIMEOUT_MS,
    )
    const clipboardCommandTimeoutMs = yield* resolveCommandTimeoutMs(
      options?.commandTimeoutMs,
      DEFAULT_CLIPBOARD_COMMAND_TIMEOUT_MS,
    )

    if (!shouldAttemptClipboardPaste(mode, text)) {
      return yield* typeTextWithWtypeDirect(wtypeExecutable, text, directCommandTimeoutMs)
    }

    const wlCopyExecutable = findOptionalWlCopyExecutable()
    if (wlCopyExecutable === undefined) {
      return yield* typeTextWithWtypeDirect(wtypeExecutable, text, directCommandTimeoutMs)
    }

    const wlPasteExecutable = findOptionalWlPasteExecutable()
    const previousClipboard = yield* readClipboardText(wlPasteExecutable, clipboardCommandTimeoutMs)

    return yield* typeTextWithWtypeClipboardPaste({
      wtypeExecutable,
      wlCopyExecutable,
      previousClipboard,
      text,
      commandTimeoutMs: clipboardCommandTimeoutMs,
    }).pipe(
      Effect.catch(() => typeTextWithWtypeDirect(wtypeExecutable, text, directCommandTimeoutMs)),
    )
  })
