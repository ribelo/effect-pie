import { Data, Effect } from "effect"

import { normalizeTextForTypingBackend } from "../input/textNormalization.js"
import { findExecutable, runExternalTool } from "../utils/subprocess.js"

export class WtypeError extends Data.TaggedError("WtypeError")<{
  readonly message: string
  readonly cause?: unknown
  readonly stderr?: string
}> {}

const DEFAULT_DIRECT_COMMAND_TIMEOUT_MS = 30_000
const DEFAULT_CLIPBOARD_COMMAND_TIMEOUT_MS = 2_000
const MAX_COMMAND_TIMEOUT_MS = 300_000

const runCommand = (
  commandArgs: ReadonlyArray<string>,
  executableName: string,
  timeoutMs: number,
): Effect.Effect<{ readonly stdout: string; readonly stderr: string }, WtypeError> =>
  runExternalTool({ command: commandArgs, timeoutMs }).pipe(
    Effect.mapError(
      (cause) =>
        new WtypeError({
          message: cause.message.replace("Subprocess", executableName),
          cause,
        }),
    ),
  )

const buildWtypeCommandArgs = (wtypeExecutable: string, text: string, delayMs = 0): Array<string> =>
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

const SAFE_DIRECT_TYPING_CHARACTERS = /^[\x20-\x7E]*$/u

const PROBLEMATIC_DIRECT_CHARACTERS = /[\\$`"'\u2018\u2019]/u

export const shouldUseWtypeClipboardPaste = (text: string): boolean => {
  if (!SAFE_DIRECT_TYPING_CHARACTERS.test(text)) {
    return true
  }

  return PROBLEMATIC_DIRECT_CHARACTERS.test(text)
}

export type WtypeInjectionMode = "direct" | "clipboard" | "auto"

export const resolveWtypeInjectionMode = (
  env: NodeJS.ProcessEnv = process.env,
): Effect.Effect<WtypeInjectionMode, WtypeError> => {
  const rawMode = (
    env["PIE_WAYLAND_INJECTION_MODE"] ??
    env["EFFECT_PI_WAYLAND_INJECTION_MODE"] ??
    "auto"
  )
    .trim()
    .toLowerCase()

  if (rawMode === "direct" || rawMode === "clipboard" || rawMode === "auto") {
    return Effect.succeed(rawMode)
  }

  return Effect.fail(
    new WtypeError({
      message: `Invalid PIE_WAYLAND_INJECTION_MODE value "${rawMode}". Valid options: direct, clipboard, auto.`,
    }),
  )
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

const findWtypeExecutable = findExecutable({
  name: "wtype",
  missingMessage: "wtype is required but was not found in PATH",
}).pipe(
  Effect.mapError(
    (cause) =>
      new WtypeError({
        message: cause.message,
        cause,
      }),
  ),
)

const findOptionalWlCopyExecutable = Effect.sync(() => Bun.which("wl-copy") ?? undefined)

const findOptionalWlPasteExecutable = Effect.sync(() => Bun.which("wl-paste") ?? undefined)

const typeTextWithWtypeDirect = (
  wtypeExecutable: string,
  text: string,
  commandTimeoutMs: number,
  delayMs?: number,
): Effect.Effect<void, WtypeError> => {
  const resolvedDelayMs =
    delayMs ?? (Array.from(text).some((char) => char.charCodeAt(0) > 127) ? 8 : 0)
  const commandArgs = buildWtypeCommandArgs(wtypeExecutable, text, resolvedDelayMs)

  return runCommand(commandArgs, "wtype", commandTimeoutMs).pipe(Effect.asVoid)
}

const readClipboardText = (
  wlPasteExecutable: string | undefined,
  commandTimeoutMs: number,
): Effect.Effect<string | undefined, WtypeError> => {
  if (wlPasteExecutable === undefined) {
    return Effect.succeed(undefined)
  }

  return runCommand(buildWlPasteCommandArgs(wlPasteExecutable), "wl-paste", commandTimeoutMs).pipe(
    Effect.map(({ stdout }) => stdout),
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
    ).pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("Failed to restore clipboard after paste injection").pipe(
          Effect.annotateLogs({ cause }),
        ),
      ),
      Effect.catch(() => Effect.void),
    )
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
        new WtypeError({
          message: `commandTimeoutMs must be a positive number up to ${MAX_COMMAND_TIMEOUT_MS}`,
        }),
      )
}

export const typeTextWithWtype = Effect.fn("pie/wayland/wtype.typeTextWithWtype")(function* (
  text: string,
  options?: {
    readonly mode?: WtypeInjectionMode
    readonly commandTimeoutMs?: number
    readonly delayMs?: number
  },
): Effect.fn.Return<void, WtypeError> {
  const normalizedText = normalizeTextForTypingBackend(text)
  if (normalizedText.length === 0) {
    return
  }

  yield* Effect.annotateCurrentSpan({
    "injection.chars": normalizedText.length,
  })

  const wtypeExecutable = yield* findWtypeExecutable
  const mode = options?.mode ?? (yield* resolveWtypeInjectionMode())
  const directCommandTimeoutMs = yield* resolveCommandTimeoutMs(
    options?.commandTimeoutMs,
    DEFAULT_DIRECT_COMMAND_TIMEOUT_MS,
  )
  const clipboardCommandTimeoutMs = yield* resolveCommandTimeoutMs(
    options?.commandTimeoutMs,
    DEFAULT_CLIPBOARD_COMMAND_TIMEOUT_MS,
  )

  if (!shouldAttemptClipboardPaste(mode, normalizedText)) {
    return yield* typeTextWithWtypeDirect(
      wtypeExecutable,
      normalizedText,
      directCommandTimeoutMs,
      options?.delayMs,
    )
  }

  const wlCopyExecutable = yield* findOptionalWlCopyExecutable
  if (wlCopyExecutable === undefined) {
    return yield* typeTextWithWtypeDirect(
      wtypeExecutable,
      normalizedText,
      directCommandTimeoutMs,
      options?.delayMs,
    )
  }

  const wlPasteExecutable = yield* findOptionalWlPasteExecutable
  const previousClipboard = yield* readClipboardText(
    wlPasteExecutable,
    clipboardCommandTimeoutMs,
  ).pipe(
    Effect.tapError((cause) =>
      Effect.logWarning("Clipboard read failed; falling back to direct typing").pipe(
        Effect.annotateLogs({ cause }),
      ),
    ),
    Effect.catch(() => Effect.succeed(undefined)),
  )

  return yield* typeTextWithWtypeClipboardPaste({
    wtypeExecutable,
    wlCopyExecutable,
    previousClipboard,
    text: normalizedText,
    commandTimeoutMs: clipboardCommandTimeoutMs,
  }).pipe(
    Effect.catch(() =>
      typeTextWithWtypeDirect(
        wtypeExecutable,
        normalizedText,
        directCommandTimeoutMs,
        options?.delayMs,
      ),
    ),
  )
})
