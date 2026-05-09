import { Context, Effect, Layer, Stream } from "effect"
import type { Schema } from "effect"

import type { NiriError } from "./errors.js"
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
  NiriTransport,
  type WorkspaceReference,
} from "./transport.js"

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
        readonly showPointer?: boolean
        readonly path?: string
      }) => Effect.Effect<void, NiriError>
      readonly setWindowWidth: (
        change: Extract<NiriAction, { readonly type: "set-window-width" }>["change"],
        id?: number,
      ) => Effect.Effect<void, NiriError>
      readonly setDynamicCastMonitor: (output?: string) => Effect.Effect<void, NiriError>
      readonly loadConfigFile: (path?: string) => Effect.Effect<void, NiriError>
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
  static readonly layer = Layer.effect(
    Niri,
    Effect.gen(function* () {
      const transport = yield* NiriTransport
      const read = <S extends Schema.Decoder<unknown>>(
        label: string,
        schema: S,
        request: Parameters<typeof transport.read>[0],
      ): Effect.Effect<S["Type"], NiriError> =>
        transport
          .read(request)
          .pipe(Effect.flatMap((payload) => decodeNiriJson(label, schema, payload)))
      const configureOutput = (output: string, action: NiriOutputAction) =>
        transport
          .runOutput(output, action)
          .pipe(
            Effect.flatMap((payload) =>
              decodeNiriJson("output", OutputConfigChangedSchema, payload),
            ),
          )

      const closeWindow = (id?: number) =>
        id === undefined
          ? transport.runAction({ type: "close-window" })
          : transport.runAction({ type: "close-window", id })
      const moveWindowToWorkspace = (
        reference: WorkspaceReference,
        options?: { readonly windowId?: number; readonly focus?: boolean },
      ) =>
        transport.runAction({
          type: "move-window-to-workspace",
          reference,
          ...(options?.windowId === undefined ? {} : { windowId: options.windowId }),
          ...(options?.focus === undefined ? {} : { focus: options.focus }),
        })
      const setWindowWidth = (
        change: Extract<NiriAction, { readonly type: "set-window-width" }>["change"],
        id?: number,
      ) =>
        id === undefined
          ? transport.runAction({ type: "set-window-width", change })
          : transport.runAction({ type: "set-window-width", change, id })
      const setDynamicCastMonitor = (output?: string) =>
        output === undefined
          ? transport.runAction({ type: "set-dynamic-cast-monitor" })
          : transport.runAction({ type: "set-dynamic-cast-monitor", output })
      const loadConfigFile = (path?: string) =>
        path === undefined
          ? transport.runAction({ type: "load-config-file" })
          : transport.runAction({ type: "load-config-file", path })

      return Niri.of({
        version: read("version", VersionSchema, "version"),
        outputs: read("outputs", OutputsSchema, "outputs"),
        workspaces: read("workspaces", WorkspacesSchema, "workspaces"),
        windows: read("windows", WindowsSchema, "windows"),
        layers: read("layers", LayersSchema, "layers"),
        keyboardLayouts: read("keyboard-layouts", KeyboardLayoutsSchema, "keyboard-layouts"),
        focusedOutput: read("focused-output", FocusedOutputSchema, "focused-output"),
        focusedWindow: read("focused-window", FocusedWindowSchema, "focused-window"),
        pickWindow: read("pick-window", PickedWindowSchema, "pick-window"),
        pickColor: read("pick-color", PickedColorSchema, "pick-color"),
        overviewState: read("overview-state", OverviewSchema, "overview-state"),
        runAction: transport.runAction,
        configureOutput,
        actions: {
          raw: (args) => transport.runAction({ type: "raw", args }),
          focusWindow: (id) => transport.runAction({ type: "focus-window", id }),
          closeWindow,
          moveWindowToWorkspace,
          screenshotWindow: (options) =>
            transport.runAction({ type: "screenshot-window", ...options }),
          setWindowWidth,
          setDynamicCastMonitor,
          loadConfigFile,
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
        events: transport.eventStreamLines.pipe(Stream.mapEffect(decodeNiriEventJson)),
      })
    }),
  )

  static readonly live = Niri.layer.pipe(Layer.provide(NiriTransport.layer()))
}
