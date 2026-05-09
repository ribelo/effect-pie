import { Context, Effect, Layer, Stream } from "effect"

import {
  NiriIpcError,
  NiriTimeoutError,
  NiriUnavailableError,
  NiriValidationError,
  type NiriError,
} from "./errors.js"

export type NiriReadRequest =
  | "version"
  | "outputs"
  | "workspaces"
  | "windows"
  | "layers"
  | "keyboard-layouts"
  | "focused-output"
  | "focused-window"
  | "pick-window"
  | "pick-color"
  | "overview-state"

export type WorkspaceReference =
  | { readonly type: "id"; readonly id: number }
  | { readonly type: "index"; readonly index: number }
  | { readonly type: "name"; readonly name: string }

export type SizeChange =
  | { readonly type: "set-fixed"; readonly value: number }
  | { readonly type: "set-proportion"; readonly value: number }
  | { readonly type: "adjust-fixed"; readonly value: number }
  | { readonly type: "adjust-proportion"; readonly value: number }

export type PositionChange = SizeChange

export type NiriAction =
  | { readonly type: "raw"; readonly args: ReadonlyArray<string> }
  | { readonly type: "quit"; readonly skipConfirmation?: boolean }
  | { readonly type: "spawn"; readonly command: ReadonlyArray<string> }
  | { readonly type: "spawn-sh"; readonly command: string }
  | { readonly type: "do-screen-transition"; readonly delayMs?: number }
  | { readonly type: "screenshot"; readonly showPointer?: boolean; readonly path?: string }
  | {
      readonly type: "screenshot-screen"
      readonly writeToDisk?: boolean
      readonly showPointer?: boolean
      readonly path?: string
    }
  | {
      readonly type: "screenshot-window"
      readonly id?: number
      readonly writeToDisk?: boolean
      readonly showPointer?: boolean
      readonly path?: string
    }
  | { readonly type: "close-window"; readonly id?: number }
  | { readonly type: "fullscreen-window"; readonly id?: number }
  | { readonly type: "toggle-windowed-fullscreen"; readonly id?: number }
  | { readonly type: OptionalWindowIdAction; readonly id?: number }
  | { readonly type: "focus-window"; readonly id: number }
  | { readonly type: "focus-window-in-column"; readonly index: number }
  | { readonly type: "focus-column"; readonly index: number }
  | { readonly type: "move-column-to-index"; readonly index: number }
  | { readonly type: "set-column-display"; readonly display: "normal" | "tabbed" }
  | { readonly type: "focus-workspace"; readonly reference: WorkspaceReference }
  | {
      readonly type: "move-window-to-workspace"
      readonly reference: WorkspaceReference
      readonly windowId?: number
      readonly focus?: boolean
    }
  | {
      readonly type: "move-column-to-workspace"
      readonly reference: WorkspaceReference
      readonly focus?: boolean
    }
  | {
      readonly type: "move-workspace-to-index"
      readonly index: number
      readonly reference?: WorkspaceReference
    }
  | {
      readonly type: "set-workspace-name"
      readonly name: string
      readonly workspace?: WorkspaceReference
    }
  | { readonly type: "unset-workspace-name"; readonly reference?: WorkspaceReference }
  | { readonly type: "focus-monitor"; readonly output: string }
  | { readonly type: "move-window-to-monitor"; readonly output: string; readonly id?: number }
  | { readonly type: "move-column-to-monitor"; readonly output: string }
  | { readonly type: "set-window-width"; readonly change: SizeChange; readonly id?: number }
  | { readonly type: "set-window-height"; readonly change: SizeChange; readonly id?: number }
  | { readonly type: "reset-window-height"; readonly id?: number }
  | { readonly type: "set-column-width"; readonly change: SizeChange }
  | { readonly type: "switch-layout"; readonly layout: "next" | "prev" | number }
  | {
      readonly type: "move-workspace-to-monitor"
      readonly output: string
      readonly reference?: WorkspaceReference
    }
  | {
      readonly type: "move-floating-window"
      readonly id?: number
      readonly x?: PositionChange
      readonly y?: PositionChange
    }
  | { readonly type: "set-dynamic-cast-window"; readonly id?: number }
  | { readonly type: "set-dynamic-cast-monitor"; readonly output?: string }
  | { readonly type: "toggle-window-urgent"; readonly id: number }
  | { readonly type: "set-window-urgent"; readonly id: number }
  | { readonly type: "unset-window-urgent"; readonly id: number }
  | { readonly type: "load-config-file"; readonly path?: string }
  | { readonly type: SimpleAction }

export type SimpleAction =
  | "power-off-monitors"
  | "power-on-monitors"
  | "toggle-keyboard-shortcuts-inhibit"
  | "focus-window-previous"
  | "focus-column-left"
  | "focus-column-right"
  | "focus-column-first"
  | "focus-column-last"
  | "focus-column-right-or-first"
  | "focus-column-left-or-last"
  | "focus-window-or-monitor-up"
  | "focus-window-or-monitor-down"
  | "focus-column-or-monitor-left"
  | "focus-column-or-monitor-right"
  | "focus-window-down"
  | "focus-window-up"
  | "focus-window-down-or-column-left"
  | "focus-window-down-or-column-right"
  | "focus-window-up-or-column-left"
  | "focus-window-up-or-column-right"
  | "focus-window-or-workspace-down"
  | "focus-window-or-workspace-up"
  | "focus-window-top"
  | "focus-window-bottom"
  | "focus-window-down-or-top"
  | "focus-window-up-or-bottom"
  | "move-column-left"
  | "move-column-right"
  | "move-column-to-first"
  | "move-column-to-last"
  | "move-column-left-or-to-monitor-left"
  | "move-column-right-or-to-monitor-right"
  | "move-window-down"
  | "move-window-up"
  | "move-window-down-or-to-workspace-down"
  | "move-window-up-or-to-workspace-up"
  | "consume-window-into-column"
  | "expel-window-from-column"
  | "swap-window-right"
  | "swap-window-left"
  | "toggle-column-tabbed-display"
  | "center-column"
  | "center-visible-columns"
  | "focus-workspace-down"
  | "focus-workspace-up"
  | "focus-workspace-previous"
  | "move-window-to-workspace-down"
  | "move-window-to-workspace-up"
  | "move-column-to-workspace-down"
  | "move-column-to-workspace-up"
  | "move-workspace-down"
  | "move-workspace-up"
  | "focus-monitor-left"
  | "focus-monitor-right"
  | "focus-monitor-down"
  | "focus-monitor-up"
  | "focus-monitor-previous"
  | "focus-monitor-next"
  | "move-window-to-monitor-left"
  | "move-window-to-monitor-right"
  | "move-window-to-monitor-down"
  | "move-window-to-monitor-up"
  | "move-window-to-monitor-previous"
  | "move-window-to-monitor-next"
  | "move-column-to-monitor-left"
  | "move-column-to-monitor-right"
  | "move-column-to-monitor-down"
  | "move-column-to-monitor-up"
  | "move-column-to-monitor-previous"
  | "move-column-to-monitor-next"
  | "switch-preset-column-width"
  | "switch-preset-column-width-back"
  | "maximize-column"
  | "expand-column-to-available-width"
  | "show-hotkey-overlay"
  | "move-workspace-to-monitor-left"
  | "move-workspace-to-monitor-right"
  | "move-workspace-to-monitor-down"
  | "move-workspace-to-monitor-up"
  | "move-workspace-to-monitor-previous"
  | "move-workspace-to-monitor-next"
  | "toggle-debug-tint"
  | "debug-toggle-opaque-regions"
  | "debug-toggle-damage"
  | "focus-floating"
  | "focus-tiling"
  | "switch-focus-between-floating-and-tiling"
  | "clear-dynamic-cast-target"
  | "toggle-overview"
  | "open-overview"
  | "close-overview"

export type OptionalWindowIdAction =
  | "consume-or-expel-window-left"
  | "consume-or-expel-window-right"
  | "center-window"
  | "switch-preset-window-width"
  | "switch-preset-window-width-back"
  | "switch-preset-window-height"
  | "switch-preset-window-height-back"
  | "maximize-window-to-edges"
  | "toggle-window-floating"
  | "move-window-to-floating"
  | "move-window-to-tiling"
  | "toggle-window-rule-opacity"

const simpleActionNames: ReadonlySet<string> = new Set([
  "power-off-monitors",
  "power-on-monitors",
  "toggle-keyboard-shortcuts-inhibit",
  "focus-window-previous",
  "focus-column-left",
  "focus-column-right",
  "focus-column-first",
  "focus-column-last",
  "focus-column-right-or-first",
  "focus-column-left-or-last",
  "focus-window-or-monitor-up",
  "focus-window-or-monitor-down",
  "focus-column-or-monitor-left",
  "focus-column-or-monitor-right",
  "focus-window-down",
  "focus-window-up",
  "focus-window-down-or-column-left",
  "focus-window-down-or-column-right",
  "focus-window-up-or-column-left",
  "focus-window-up-or-column-right",
  "focus-window-or-workspace-down",
  "focus-window-or-workspace-up",
  "focus-window-top",
  "focus-window-bottom",
  "focus-window-down-or-top",
  "focus-window-up-or-bottom",
  "move-column-left",
  "move-column-right",
  "move-column-to-first",
  "move-column-to-last",
  "move-column-left-or-to-monitor-left",
  "move-column-right-or-to-monitor-right",
  "move-window-down",
  "move-window-up",
  "move-window-down-or-to-workspace-down",
  "move-window-up-or-to-workspace-up",
  "consume-window-into-column",
  "expel-window-from-column",
  "swap-window-right",
  "swap-window-left",
  "toggle-column-tabbed-display",
  "center-column",
  "center-visible-columns",
  "focus-workspace-down",
  "focus-workspace-up",
  "focus-workspace-previous",
  "move-window-to-workspace-down",
  "move-window-to-workspace-up",
  "move-column-to-workspace-down",
  "move-column-to-workspace-up",
  "move-workspace-down",
  "move-workspace-up",
  "focus-monitor-left",
  "focus-monitor-right",
  "focus-monitor-down",
  "focus-monitor-up",
  "focus-monitor-previous",
  "focus-monitor-next",
  "move-window-to-monitor-left",
  "move-window-to-monitor-right",
  "move-window-to-monitor-down",
  "move-window-to-monitor-up",
  "move-window-to-monitor-previous",
  "move-window-to-monitor-next",
  "move-column-to-monitor-left",
  "move-column-to-monitor-right",
  "move-column-to-monitor-down",
  "move-column-to-monitor-up",
  "move-column-to-monitor-previous",
  "move-column-to-monitor-next",
  "switch-preset-column-width",
  "switch-preset-column-width-back",
  "maximize-column",
  "expand-column-to-available-width",
  "show-hotkey-overlay",
  "move-workspace-to-monitor-left",
  "move-workspace-to-monitor-right",
  "move-workspace-to-monitor-down",
  "move-workspace-to-monitor-up",
  "move-workspace-to-monitor-previous",
  "move-workspace-to-monitor-next",
  "toggle-debug-tint",
  "debug-toggle-opaque-regions",
  "debug-toggle-damage",
  "focus-floating",
  "focus-tiling",
  "switch-focus-between-floating-and-tiling",
  "clear-dynamic-cast-target",
  "toggle-overview",
  "open-overview",
  "close-overview",
])

const isSimpleAction = (type: NiriAction["type"]): type is SimpleAction =>
  simpleActionNames.has(type)

export type NiriOutputAction =
  | { readonly type: "off" }
  | { readonly type: "on" }
  | {
      readonly type: "mode"
      readonly mode:
        | "auto"
        | { readonly width: number; readonly height: number; readonly refresh?: number }
    }
  | {
      readonly type: "custom-mode"
      readonly width: number
      readonly height: number
      readonly refresh?: number
    }
  | {
      readonly type: "modeline"
      readonly clock: number
      readonly hdisplay: number
      readonly hsyncStart: number
      readonly hsyncEnd: number
      readonly htotal: number
      readonly vdisplay: number
      readonly vsyncStart: number
      readonly vsyncEnd: number
      readonly vtotal: number
      readonly hsyncPolarity: "+hsync" | "-hsync"
      readonly vsyncPolarity: "+vsync" | "-vsync"
    }
  | { readonly type: "scale"; readonly scale: "auto" | number }
  | { readonly type: "transform"; readonly transform: OutputTransform }
  | {
      readonly type: "position"
      readonly position:
        | { readonly type: "auto" }
        | { readonly type: "set"; readonly x: number; readonly y: number }
    }
  | { readonly type: "vrr"; readonly enabled: boolean; readonly onDemand?: boolean }

export type OutputTransform =
  | "normal"
  | "90"
  | "180"
  | "270"
  | "flipped"
  | "flipped-90"
  | "flipped-180"
  | "flipped-270"

const positiveInteger = (value: number, label: string): void => {
  if (!Number.isInteger(value) || value <= 0) {
    throw new NiriValidationError({ message: `${label} must be a positive integer` })
  }
}

const finiteNumber = (value: number, label: string): void => {
  if (!Number.isFinite(value)) {
    throw new NiriValidationError({ message: `${label} must be finite` })
  }
}

const nonEmpty = (value: string, label: string): void => {
  if (value.trim().length === 0) {
    throw new NiriValidationError({ message: `${label} must not be empty` })
  }
}

const maybeIdArgs = (flag: string, id: number | undefined): Array<string> => {
  if (id === undefined) {
    return []
  }
  positiveInteger(id, "window id")
  return [flag, String(id)]
}

const maybeBooleanArg = (flag: string, value: boolean | undefined): Array<string> =>
  value === undefined ? [] : [flag, String(value)]

const maybeStringArg = (flag: string, value: string | undefined): Array<string> => {
  if (value === undefined) {
    return []
  }
  nonEmpty(value, flag)
  return [flag, value]
}

export const workspaceReferenceArg = (reference: WorkspaceReference): string => {
  switch (reference.type) {
    case "id":
      positiveInteger(reference.id, "workspace id")
      return String(reference.id)
    case "index":
      positiveInteger(reference.index, "workspace index")
      if (reference.index > 255) {
        throw new NiriValidationError({ message: "workspace index must be between 1 and 255" })
      }
      return String(reference.index)
    case "name":
      nonEmpty(reference.name, "workspace name")
      return reference.name
  }
}

export const sizeChangeArg = (change: SizeChange): string => {
  finiteNumber(change.value, "size change")
  switch (change.type) {
    case "set-fixed":
      return String(change.value)
    case "adjust-fixed":
      return change.value >= 0 ? `+${change.value}` : String(change.value)
    case "set-proportion":
      if (change.value <= 0) {
        throw new NiriValidationError({ message: "set proportion must be greater than 0" })
      }
      return `${change.value * 100}%`
    case "adjust-proportion":
      return `${change.value >= 0 ? "+" : ""}${change.value * 100}%`
  }
}

const configuredModeArg = (mode: {
  readonly width: number
  readonly height: number
  readonly refresh?: number
}): string => {
  positiveInteger(mode.width, "mode width")
  positiveInteger(mode.height, "mode height")
  if (mode.refresh !== undefined) {
    finiteNumber(mode.refresh, "mode refresh")
    if (mode.refresh <= 0) {
      throw new NiriValidationError({ message: "mode refresh must be greater than 0" })
    }
  }
  return `${mode.width}x${mode.height}${mode.refresh === undefined ? "" : `@${mode.refresh}`}`
}

export const buildNiriReadCommand = (
  niriPath: string,
  request: NiriReadRequest,
): ReadonlyArray<string> => [niriPath, "msg", "--json", request]

export const buildNiriEventStreamCommand = (niriPath: string): ReadonlyArray<string> => [
  niriPath,
  "msg",
  "--json",
  "event-stream",
]

export const buildNiriActionCommand = (
  niriPath: string,
  action: NiriAction,
): ReadonlyArray<string> => {
  const base = [niriPath, "msg", "action"]
  if (action.type === "raw") {
    if (action.args.length === 0) {
      throw new NiriValidationError({ message: "raw Niri action args must not be empty" })
    }
    return [...base, ...action.args]
  }

  if (isSimpleAction(action.type)) {
    return [...base, action.type]
  }

  switch (action.type) {
    case "quit":
      return [...base, "quit", ...(action.skipConfirmation === true ? ["--skip-confirmation"] : [])]
    case "spawn":
      if (action.command.length === 0) {
        throw new NiriValidationError({ message: "spawn command must not be empty" })
      }
      return [...base, "spawn", "--", ...action.command]
    case "spawn-sh":
      nonEmpty(action.command, "shell command")
      return [...base, "spawn-sh", "--", action.command]
    case "do-screen-transition":
      return [
        ...base,
        "do-screen-transition",
        ...(action.delayMs === undefined ? [] : ["--delay-ms", String(action.delayMs)]),
      ]
    case "screenshot":
      return [
        ...base,
        "screenshot",
        ...maybeBooleanArg("--show-pointer", action.showPointer),
        ...maybeStringArg("--path", action.path),
      ]
    case "screenshot-screen":
      return [
        ...base,
        "screenshot-screen",
        ...maybeBooleanArg("--write-to-disk", action.writeToDisk),
        ...maybeBooleanArg("--show-pointer", action.showPointer),
        ...maybeStringArg("--path", action.path),
      ]
    case "screenshot-window":
      return [
        ...base,
        "screenshot-window",
        ...maybeIdArgs("--id", action.id),
        ...maybeBooleanArg("--write-to-disk", action.writeToDisk),
        ...maybeBooleanArg("--show-pointer", action.showPointer),
        ...maybeStringArg("--path", action.path),
      ]
    case "close-window":
    case "fullscreen-window":
    case "toggle-windowed-fullscreen":
    case "consume-or-expel-window-left":
    case "consume-or-expel-window-right":
    case "center-window":
    case "switch-preset-window-width":
    case "switch-preset-window-width-back":
    case "switch-preset-window-height":
    case "switch-preset-window-height-back":
    case "maximize-window-to-edges":
    case "toggle-window-floating":
    case "move-window-to-floating":
    case "move-window-to-tiling":
    case "toggle-window-rule-opacity":
      return [...base, action.type, ...maybeIdArgs("--id", action.id)]
    case "focus-window":
    case "toggle-window-urgent":
    case "set-window-urgent":
    case "unset-window-urgent":
      positiveInteger(action.id, "window id")
      return [...base, action.type, "--id", String(action.id)]
    case "focus-window-in-column":
    case "focus-column":
    case "move-column-to-index":
      positiveInteger(action.index, "index")
      return [...base, action.type, String(action.index)]
    case "set-column-display":
      return [...base, "set-column-display", action.display]
    case "focus-workspace":
      return [...base, "focus-workspace", workspaceReferenceArg(action.reference)]
    case "move-window-to-workspace":
      return [
        ...base,
        "move-window-to-workspace",
        ...maybeIdArgs("--window-id", action.windowId),
        ...maybeBooleanArg("--focus", action.focus),
        workspaceReferenceArg(action.reference),
      ]
    case "move-column-to-workspace":
      return [
        ...base,
        "move-column-to-workspace",
        ...maybeBooleanArg("--focus", action.focus),
        workspaceReferenceArg(action.reference),
      ]
    case "move-workspace-to-index":
      positiveInteger(action.index, "workspace index")
      return [
        ...base,
        "move-workspace-to-index",
        ...(action.reference === undefined
          ? []
          : ["--reference", workspaceReferenceArg(action.reference)]),
        String(action.index),
      ]
    case "set-workspace-name":
      nonEmpty(action.name, "workspace name")
      return [
        ...base,
        "set-workspace-name",
        ...(action.workspace === undefined
          ? []
          : ["--workspace", workspaceReferenceArg(action.workspace)]),
        action.name,
      ]
    case "unset-workspace-name":
      return [
        ...base,
        "unset-workspace-name",
        ...(action.reference === undefined ? [] : [workspaceReferenceArg(action.reference)]),
      ]
    case "focus-monitor":
    case "move-column-to-monitor":
      nonEmpty(action.output, "output name")
      return [...base, action.type, action.output]
    case "move-window-to-monitor":
      nonEmpty(action.output, "output name")
      return [...base, "move-window-to-monitor", ...maybeIdArgs("--id", action.id), action.output]
    case "set-window-width":
    case "set-window-height":
      return [...base, action.type, ...maybeIdArgs("--id", action.id), sizeChangeArg(action.change)]
    case "reset-window-height":
      return [...base, "reset-window-height", ...maybeIdArgs("--id", action.id)]
    case "set-column-width":
      return [...base, "set-column-width", sizeChangeArg(action.change)]
    case "switch-layout":
      if (typeof action.layout === "number") {
        positiveInteger(action.layout, "layout index")
      }
      return [...base, "switch-layout", String(action.layout)]
    case "move-workspace-to-monitor":
      nonEmpty(action.output, "output name")
      return [
        ...base,
        "move-workspace-to-monitor",
        ...(action.reference === undefined
          ? []
          : ["--reference", workspaceReferenceArg(action.reference)]),
        action.output,
      ]
    case "move-floating-window":
      return [
        ...base,
        "move-floating-window",
        ...maybeIdArgs("--id", action.id),
        "--x",
        sizeChangeArg(action.x ?? { type: "adjust-fixed", value: 0 }),
        "--y",
        sizeChangeArg(action.y ?? { type: "adjust-fixed", value: 0 }),
      ]
    case "set-dynamic-cast-window":
      return [...base, "set-dynamic-cast-window", ...maybeIdArgs("--id", action.id)]
    case "set-dynamic-cast-monitor":
      return [
        ...base,
        "set-dynamic-cast-monitor",
        ...(action.output === undefined ? [] : [action.output]),
      ]
    case "load-config-file":
      return [...base, "load-config-file", ...maybeStringArg("--path", action.path)]
  }
}

export const buildNiriOutputCommand = (
  niriPath: string,
  output: string,
  action: NiriOutputAction,
): ReadonlyArray<string> => {
  nonEmpty(output, "output name")
  const base = [niriPath, "msg", "--json", "output", output]
  switch (action.type) {
    case "off":
    case "on":
      return [...base, action.type]
    case "mode":
      return [...base, "mode", action.mode === "auto" ? "auto" : configuredModeArg(action.mode)]
    case "custom-mode":
      return [...base, "custom-mode", configuredModeArg(action)]
    case "modeline":
      for (const [label, value] of Object.entries(action)) {
        if (label !== "type" && typeof value === "number") {
          finiteNumber(value, label)
        }
      }
      return [
        ...base,
        "modeline",
        String(action.clock),
        String(action.hdisplay),
        String(action.hsyncStart),
        String(action.hsyncEnd),
        String(action.htotal),
        String(action.vdisplay),
        String(action.vsyncStart),
        String(action.vsyncEnd),
        String(action.vtotal),
        action.hsyncPolarity,
        action.vsyncPolarity,
      ]
    case "scale":
      if (action.scale !== "auto") {
        finiteNumber(action.scale, "scale")
        if (action.scale <= 0) {
          throw new NiriValidationError({ message: "scale must be greater than 0" })
        }
      }
      return [...base, "scale", String(action.scale)]
    case "transform":
      return [...base, "transform", action.transform]
    case "position":
      return action.position.type === "auto"
        ? [...base, "position", "auto"]
        : [...base, "position", "set", String(action.position.x), String(action.position.y)]
    case "vrr":
      return [
        ...base,
        "vrr",
        ...(action.onDemand === true ? ["--on-demand"] : []),
        String(action.enabled),
      ]
  }
}

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

export class NiriTransport extends Context.Service<
  NiriTransport,
  {
    readonly read: (request: NiriReadRequest) => Effect.Effect<string, NiriError>
    readonly runAction: (action: NiriAction) => Effect.Effect<void, NiriError>
    readonly runOutput: (
      output: string,
      action: NiriOutputAction,
    ) => Effect.Effect<string, NiriError>
    readonly eventStreamLines: Stream.Stream<string, NiriError>
  }
>()("pie/niri/NiriTransport") {
  static readonly layer = (config?: { readonly timeoutMs?: number }) =>
    Layer.effect(
      NiriTransport,
      Effect.gen(function* () {
        const niriPath = yield* findNiriExecutable()
        const timeoutMs = config?.timeoutMs ?? 5_000
        return NiriTransport.of({
          read: (request) => runNiriCommand(buildNiriReadCommand(niriPath, request), timeoutMs),
          runAction: (action) =>
            runNiriCommand(buildNiriActionCommand(niriPath, action), timeoutMs).pipe(Effect.asVoid),
          runOutput: (output, action) =>
            runNiriCommand(buildNiriOutputCommand(niriPath, output, action), timeoutMs),
          eventStreamLines: streamNiriCommandLines(buildNiriEventStreamCommand(niriPath)),
        })
      }),
    )
}
