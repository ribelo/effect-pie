import { Effect } from "effect"

export class WtypeError extends Error {
  readonly stderr: string | undefined

  constructor(message: string, options?: { readonly cause?: unknown; readonly stderr?: string }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = "WtypeError"
    this.stderr = options?.stderr
  }
}

const readStreamText = async (stream: ReadableStream<Uint8Array> | null): Promise<string> => {
  if (stream === null) {
    return ""
  }

  return await new Response(stream).text()
}

const runCommand = (
  commandArgs: Array<string>,
  executableName: string,
): Effect.Effect<{ readonly stdout: string; readonly stderr: string }, WtypeError> =>
  Effect.tryPromise({
    try: async () => {
      const process = Bun.spawn(commandArgs, {
        stdout: "pipe",
        stderr: "pipe",
      })

      const [exitCode, stdout, stderr] = await Promise.all([
        process.exited,
        readStreamText(process.stdout),
        readStreamText(process.stderr),
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

const findWtypeExecutable = Effect.sync(() => {
  const executable = Bun.which("wtype")
  if (executable === null) {
    throw new WtypeError("wtype is required but was not found in PATH")
  }

  return executable
})

const findOptionalWlCopyExecutable = (): string | undefined => Bun.which("wl-copy") ?? undefined

const findOptionalWlPasteExecutable = (): string | undefined => Bun.which("wl-paste") ?? undefined

const validateInputText = (text: string): Effect.Effect<void, WtypeError> =>
  text.trim().length > 0 ? Effect.void : Effect.fail(new WtypeError("--text must not be empty"))

const typeTextWithWtypeDirect = (
  wtypeExecutable: string,
  text: string,
): Effect.Effect<void, WtypeError> => {
  const delayMs = Array.from(text).some((char) => char.charCodeAt(0) > 127) ? 8 : 0
  const commandArgs = buildWtypeCommandArgs(wtypeExecutable, text, delayMs)

  return runCommand(commandArgs, "wtype").pipe(Effect.asVoid)
}

const readClipboardText = (
  wlPasteExecutable: string | undefined,
): Effect.Effect<string | undefined> => {
  if (wlPasteExecutable === undefined) {
    return Effect.as(Effect.void, undefined)
  }

  return runCommand(buildWlPasteCommandArgs(wlPasteExecutable), "wl-paste").pipe(
    Effect.map(({ stdout }) => stdout),
    Effect.catch(() => Effect.as(Effect.void, undefined)),
  )
}

const typeTextWithWtypeClipboardPaste = (config: {
  readonly wtypeExecutable: string
  readonly wlCopyExecutable: string
  readonly previousClipboard: string | undefined
  readonly text: string
}): Effect.Effect<void, WtypeError> =>
  Effect.gen(function* () {
    yield* runCommand(buildWlCopyCommandArgs(config.wlCopyExecutable, config.text), "wl-copy")
    yield* runCommand(buildWtypePasteShortcutArgs(config.wtypeExecutable), "wtype")

    if (config.previousClipboard === undefined) {
      return
    }

    yield* runCommand(
      buildWlCopyCommandArgs(config.wlCopyExecutable, config.previousClipboard),
      "wl-copy",
    ).pipe(Effect.catch(() => Effect.void))
  })

export const typeTextWithWtype = (
  text: string,
  options?: {
    readonly mode?: WtypeInjectionMode
  },
): Effect.Effect<void, WtypeError> =>
  Effect.gen(function* () {
    yield* validateInputText(text)
    const wtypeExecutable = yield* findWtypeExecutable
    const mode = options?.mode ?? resolveWtypeInjectionMode()

    if (!shouldAttemptClipboardPaste(mode, text)) {
      return yield* typeTextWithWtypeDirect(wtypeExecutable, text)
    }

    const wlCopyExecutable = findOptionalWlCopyExecutable()
    if (wlCopyExecutable === undefined) {
      return yield* typeTextWithWtypeDirect(wtypeExecutable, text)
    }

    const wlPasteExecutable = findOptionalWlPasteExecutable()
    const previousClipboard = yield* readClipboardText(wlPasteExecutable)

    return yield* typeTextWithWtypeClipboardPaste({
      wtypeExecutable,
      wlCopyExecutable,
      previousClipboard,
      text,
    }).pipe(Effect.catch(() => typeTextWithWtypeDirect(wtypeExecutable, text)))
  })
