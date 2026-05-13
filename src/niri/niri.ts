import { Context, Effect, Layer, Stream } from "effect"
import type { Schema } from "effect"

import {
  NiriIpcError,
  NiriTimeoutError,
  NiriUnavailableError,
  NiriValidationError,
  type NiriError,
} from "./errors.js"
import {
  decodeNiriEventJson,
  decodeNiriJson,
  FocusedOutputSchema,
  FocusedWindowSchema,
  KeyboardLayoutsSchema,
  LayersSchema,
  OutputConfigChangedSchema,
  OutputsSchema,
  OverviewSchema,
  PickedColorSchema,
  PickedWindowSchema,
  VersionSchema,
  WindowsSchema,
  WorkspacesSchema,
  type NiriEvent,
  type NiriKeyboardLayouts,
  type NiriLayerSurface,
  type NiriOutput,
  type NiriOutputConfigChanged,
  type NiriOverview,
  type NiriPickedColor,
  type NiriVersion,
  type NiriWindow,
  type NiriWorkspace,
} from "./schema.js"
import {
  type NiriAction,
  type NiriOutputAction,
  type NiriReadRequest,
  type WorkspaceReference,
  buildNiriActionCommand,
  buildNiriEventStreamCommand,
  buildNiriOutputCommand,
  buildNiriReadCommand,
  readRequestTimeoutMs,
  NIRI_DEFAULT_TIMEOUT_MS,
} from "./commands.js"

const readStreamText = async (stream: ReadableStream<Uint8Array> | null): Promise<string> =>
  stream === null ? "" : await new Response(stream).text()

export const findNiriExecutable = (
  name: string = "niri",
): Effect.Effect<string, NiriUnavailableError> =>
  Effect.try({
    try: () => Bun.which(name),
    catch: (cause) =>
      new NiriUnavailableError({ message: `Failed to resolve ${name} executable`, cause }),
  }).pipe(
    Effect.flatMap((executable) =>
      executable === null
        ? Effect.fail(
            new NiriUnavailableError({
              message: `${name} executable was not found in PATH; install niri or fix PATH before using Niri IPC`,
            }),
          )
        : Effect.succeed(executable),
    ),
  )

export const runNiriCommand = (
  command: ReadonlyArray<string>,
  timeoutMs: number,
): Effect.Effect<string, NiriIpcError | NiriTimeoutError> =>
  Effect.tryPromise({
    try: async () => {
      const process = Bun.spawn(Array.from(command), { stdout: "pipe", stderr: "pipe" })
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
              process.kill()
              reject(
                new NiriTimeoutError({
                  message: `Niri command timed out after ${timeoutMs}ms: ${command.join(" ")}`,
                  timeoutMs,
                }),
              )
            }, timeoutMs)
          }),
        ])

        if (exitCode !== 0) {
          throw new NiriIpcError({
            message:
              stderr.trim().length > 0
                ? `Niri command failed: ${stderr.trim()}`
                : `Niri command exited with code ${exitCode}`,
            stderr,
            exitCode,
          })
        }

        return stdout.trimEnd()
      } finally {
        if (timeout !== undefined) {
          clearTimeout(timeout)
        }
      }
    },
    catch: (cause) =>
      cause instanceof NiriIpcError || cause instanceof NiriTimeoutError
        ? cause
        : new NiriIpcError({ message: `Failed to run Niri command: ${command.join(" ")}`, cause }),
  })

async function* readProcessLines(
  process: Bun.Subprocess<"ignore", "pipe", "pipe">,
): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  const reader = process.stdout.getReader()
  let buffered = ""
  let completed = false
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) {
        break
      }
      buffered += decoder.decode(chunk.value, { stream: true })
      let newlineIndex = buffered.indexOf("\n")
      while (newlineIndex >= 0) {
        const line = buffered.slice(0, newlineIndex)
        buffered = buffered.slice(newlineIndex + 1)
        if (line.trim().length > 0) {
          yield line
        }
        newlineIndex = buffered.indexOf("\n")
      }
    }
    buffered += decoder.decode()
    if (buffered.trim().length > 0) {
      yield buffered
    }
    completed = true
    const [exitCode, stderr] = await Promise.all([process.exited, readStreamText(process.stderr)])
    if (exitCode !== 0) {
      throw new NiriIpcError({
        message:
          stderr.trim().length > 0
            ? `Niri event stream failed: ${stderr.trim()}`
            : `Niri event stream exited with code ${exitCode}`,
        stderr,
        exitCode,
      })
    }
  } finally {
    reader.releaseLock()
    if (!completed) {
      try {
        process.kill()
      } catch {}
    }
  }
}

export const streamNiriCommandLines = (
  command: ReadonlyArray<string>,
): Stream.Stream<string, NiriError> =>
  Stream.unwrap(
    Effect.try({
      try: () => Bun.spawn(Array.from(command), { stdout: "pipe", stderr: "pipe" }),
      catch: (cause) =>
        new NiriIpcError({
          message: `Failed to start Niri event stream: ${command.join(" ")}`,
          cause,
        }),
    }).pipe(
      Effect.map((process) =>
        Stream.fromAsyncIterable(readProcessLines(process), (cause) =>
          cause instanceof NiriIpcError ||
          cause instanceof NiriTimeoutError ||
          cause instanceof NiriUnavailableError ||
          cause instanceof NiriValidationError
            ? cause
            : new NiriIpcError({
                message: `Niri event stream failed: ${command.join(" ")}`,
                cause,
              }),
        ),
      ),
    ),
  )

export type CommandRunner = {
  readonly run: (argv: ReadonlyArray<string>, timeoutMs: number) => Effect.Effect<string, NiriError>
  readonly streamLines: (argv: ReadonlyArray<string>) => Stream.Stream<string, NiriError>
}

const buildCommand = (
  build: () => ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<string>, NiriValidationError | NiriIpcError> =>
  Effect.try({
    try: build,
    catch: (cause) =>
      cause instanceof NiriValidationError
        ? cause
        : new NiriIpcError({ message: "Failed to build Niri command", cause }),
  })

export class Niri extends Context.Service<
  Niri,
  {
    readonly version: Effect.Effect<NiriVersion, NiriError>
    readonly outputs: Effect.Effect<Record<string, NiriOutput>, NiriError>
    readonly workspaces: Effect.Effect<ReadonlyArray<NiriWorkspace>, NiriError>
    readonly windows: Effect.Effect<ReadonlyArray<NiriWindow>, NiriError>
    readonly layers: Effect.Effect<ReadonlyArray<NiriLayerSurface>, NiriError>
    readonly keyboardLayouts: Effect.Effect<NiriKeyboardLayouts, NiriError>
    readonly focusedOutput: Effect.Effect<NiriOutput | null, NiriError>
    readonly focusedWindow: Effect.Effect<NiriWindow | null, NiriError>
    readonly pickWindow: Effect.Effect<NiriWindow | null, NiriError>
    readonly pickColor: Effect.Effect<NiriPickedColor, NiriError>
    readonly overviewState: Effect.Effect<NiriOverview, NiriError>
    readonly runAction: (action: NiriAction) => Effect.Effect<void, NiriError>
    readonly configureOutput: (
      output: string,
      action: NiriOutputAction,
    ) => Effect.Effect<NiriOutputConfigChanged, NiriError>
    readonly actions: {
      readonly raw: (args: ReadonlyArray<string>) => Effect.Effect<void, NiriError>
      readonly focusWindow: (id: number) => Effect.Effect<void, NiriError>
      readonly closeWindow: (id?: number) => Effect.Effect<void, NiriError>
      readonly moveWindowToWorkspace: (
        reference: WorkspaceReference,
        options?: { readonly windowId?: number; readonly focus?: boolean },
      ) => Effect.Effect<void, NiriError>
      readonly screenshotWindow: (options?: {
        readonly id?: number
        readonly writeToDisk?: boolean
        readonly path?: string
      }) => Effect.Effect<void, NiriError>
      readonly setWindowWidth: (
        change: Extract<NiriAction, { readonly type: "set-window-width" }>["change"],
        id?: number,
      ) => Effect.Effect<void, NiriError>
      readonly setDynamicCastMonitor: (output?: string) => Effect.Effect<void, NiriError>
      readonly loadConfigFile: Effect.Effect<void, NiriError>
    }
    readonly outputsConfig: {
      readonly setScale: (
        output: string,
        scale: "auto" | number,
      ) => Effect.Effect<NiriOutputConfigChanged, NiriError>
      readonly setMode: (
        output: string,
        mode: Extract<NiriOutputAction, { readonly type: "mode" }>["mode"],
      ) => Effect.Effect<NiriOutputConfigChanged, NiriError>
      readonly setCustomMode: (
        output: string,
        mode: Omit<Extract<NiriOutputAction, { readonly type: "custom-mode" }>, "type">,
      ) => Effect.Effect<NiriOutputConfigChanged, NiriError>
      readonly setModeline: (
        output: string,
        modeline: Omit<Extract<NiriOutputAction, { readonly type: "modeline" }>, "type">,
      ) => Effect.Effect<NiriOutputConfigChanged, NiriError>
      readonly setTransform: (
        output: string,
        transform: Extract<NiriOutputAction, { readonly type: "transform" }>["transform"],
      ) => Effect.Effect<NiriOutputConfigChanged, NiriError>
      readonly setPosition: (
        output: string,
        position: Extract<NiriOutputAction, { readonly type: "position" }>["position"],
      ) => Effect.Effect<NiriOutputConfigChanged, NiriError>
      readonly setVrr: (
        output: string,
        vrr: Omit<Extract<NiriOutputAction, { readonly type: "vrr" }>, "type">,
      ) => Effect.Effect<NiriOutputConfigChanged, NiriError>
      readonly off: (output: string) => Effect.Effect<NiriOutputConfigChanged, NiriError>
      readonly on: (output: string) => Effect.Effect<NiriOutputConfigChanged, NiriError>
    }
    readonly events: Stream.Stream<NiriEvent, NiriError>
  }
>()("pie/niri/Niri") {
  static readonly live = (options?: {
    readonly niriPath?: string
    readonly timeoutMs?: number
    readonly runner?: CommandRunner
  }): Layer.Layer<Niri, NiriUnavailableError> =>
    Layer.effect(
      Niri,
      Effect.gen(function* () {
        const niriPath =
          options?.niriPath ?? (options?.runner !== undefined ? "" : yield* findNiriExecutable())
        const timeoutMs = options?.timeoutMs ?? NIRI_DEFAULT_TIMEOUT_MS

        const runner: CommandRunner = options?.runner ?? {
          run: (argv, t) => runNiriCommand(argv, t),
          streamLines: (argv) => streamNiriCommandLines(argv),
        }

        const run = <S extends Schema.Decoder<unknown>>(
          label: string,
          schema: S,
          request: NiriReadRequest,
        ): Effect.Effect<S["Type"], NiriError> =>
          runner
            .run(buildNiriReadCommand(niriPath, request), readRequestTimeoutMs(request, timeoutMs))
            .pipe(Effect.flatMap((payload) => decodeNiriJson(label, schema, payload)))

        const runActionCmd = (action: NiriAction): Effect.Effect<void, NiriError> =>
          buildCommand(() => buildNiriActionCommand(niriPath, action)).pipe(
            Effect.flatMap((argv) => runner.run(argv, timeoutMs)),
            Effect.asVoid,
          )

        const configureOutput = (
          output: string,
          action: NiriOutputAction,
        ): Effect.Effect<NiriOutputConfigChanged, NiriError> =>
          buildCommand(() => buildNiriOutputCommand(niriPath, output, action)).pipe(
            Effect.flatMap((argv) => runner.run(argv, timeoutMs)),
            Effect.flatMap((payload) =>
              decodeNiriJson("output", OutputConfigChangedSchema, payload),
            ),
          )

        const closeWindow = (id?: number) =>
          id === undefined
            ? runActionCmd({ type: "close-window" })
            : runActionCmd({ type: "close-window", id })
        const moveWindowToWorkspace = (
          reference: WorkspaceReference,
          opts?: { readonly windowId?: number; readonly focus?: boolean },
        ) =>
          runActionCmd({
            type: "move-window-to-workspace",
            reference,
            ...(opts?.windowId === undefined ? {} : { windowId: opts.windowId }),
            ...(opts?.focus === undefined ? {} : { focus: opts.focus }),
          })
        const setWindowWidth = (
          change: Extract<NiriAction, { readonly type: "set-window-width" }>["change"],
          id?: number,
        ) =>
          id === undefined
            ? runActionCmd({ type: "set-window-width", change })
            : runActionCmd({ type: "set-window-width", change, id })
        const setDynamicCastMonitor = (output?: string) =>
          output === undefined
            ? runActionCmd({ type: "set-dynamic-cast-monitor" })
            : runActionCmd({ type: "set-dynamic-cast-monitor", output })

        return Niri.of({
          version: run("version", VersionSchema, "version"),
          outputs: run("outputs", OutputsSchema, "outputs"),
          workspaces: run("workspaces", WorkspacesSchema, "workspaces"),
          windows: run("windows", WindowsSchema, "windows"),
          layers: run("layers", LayersSchema, "layers"),
          keyboardLayouts: run("keyboard-layouts", KeyboardLayoutsSchema, "keyboard-layouts"),
          focusedOutput: run("focused-output", FocusedOutputSchema, "focused-output"),
          focusedWindow: run("focused-window", FocusedWindowSchema, "focused-window"),
          pickWindow: run("pick-window", PickedWindowSchema, "pick-window"),
          pickColor: run("pick-color", PickedColorSchema, "pick-color"),
          overviewState: run("overview-state", OverviewSchema, "overview-state"),
          runAction: runActionCmd,
          configureOutput,
          actions: {
            raw: (args) => runActionCmd({ type: "raw", args }),
            focusWindow: (id) => runActionCmd({ type: "focus-window", id }),
            closeWindow,
            moveWindowToWorkspace,
            screenshotWindow: (opts) => runActionCmd({ type: "screenshot-window", ...opts }),
            setWindowWidth,
            setDynamicCastMonitor,
            loadConfigFile: runActionCmd({ type: "load-config-file" }),
          },
          outputsConfig: {
            setScale: (output, scale) => configureOutput(output, { type: "scale", scale }),
            setMode: (output, mode) => configureOutput(output, { type: "mode", mode }),
            setCustomMode: (output, mode) =>
              configureOutput(output, { type: "custom-mode", ...mode }),
            setModeline: (output, modeline) =>
              configureOutput(output, { type: "modeline", ...modeline }),
            setTransform: (output, transform) =>
              configureOutput(output, { type: "transform", transform }),
            setPosition: (output, position) =>
              configureOutput(output, { type: "position", position }),
            setVrr: (output, vrr) => configureOutput(output, { type: "vrr", ...vrr }),
            off: (output) => configureOutput(output, { type: "off" }),
            on: (output) => configureOutput(output, { type: "on" }),
          },
          events: runner
            .streamLines(buildNiriEventStreamCommand(niriPath))
            .pipe(Stream.mapEffect(decodeNiriEventJson)),
        })
      }),
    )
}
