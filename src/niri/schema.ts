import { Effect, Schema } from "effect"

import { NiriDecodeError } from "./errors.js"

const PairNumberSchema = Schema.Tuple([Schema.Number, Schema.Number])
const PairIntegerSchema = Schema.Tuple([Schema.Number, Schema.Number])
const NullableStringSchema = Schema.NullOr(Schema.String)
const NullableNumberSchema = Schema.NullOr(Schema.Number)

export const TimestampSchema = Schema.Struct({
  secs: Schema.Number,
  nanos: Schema.Number,
})

export const WindowLayoutSchema = Schema.Struct({
  pos_in_scrolling_layout: Schema.NullOr(PairIntegerSchema),
  tile_size: PairNumberSchema,
  window_size: PairIntegerSchema,
  tile_pos_in_workspace_view: Schema.NullOr(PairNumberSchema),
  window_offset_in_tile: PairNumberSchema,
})

export const WindowSchema = Schema.Struct({
  id: Schema.Number,
  title: NullableStringSchema,
  app_id: NullableStringSchema,
  pid: NullableNumberSchema,
  workspace_id: NullableNumberSchema,
  is_focused: Schema.Boolean,
  is_floating: Schema.Boolean,
  is_urgent: Schema.Boolean,
  layout: WindowLayoutSchema,
  focus_timestamp: Schema.NullOr(TimestampSchema),
})

export const FocusedWindowSchema = Schema.NullOr(WindowSchema)
export const PickedWindowSchema = Schema.NullOr(WindowSchema)
export const WindowsSchema = Schema.Array(WindowSchema)

export const WorkspaceSchema = Schema.Struct({
  id: Schema.Number,
  idx: Schema.Number,
  name: NullableStringSchema,
  output: NullableStringSchema,
  is_urgent: Schema.Boolean,
  is_active: Schema.Boolean,
  is_focused: Schema.Boolean,
  active_window_id: NullableNumberSchema,
})

export const WorkspacesSchema = Schema.Array(WorkspaceSchema)

export const TransformSchema = Schema.Literals([
  "Normal",
  "90",
  "180",
  "270",
  "Flipped",
  "Flipped90",
  "Flipped180",
  "Flipped270",
])

export const ModeSchema = Schema.Struct({
  width: Schema.Number,
  height: Schema.Number,
  refresh_rate: Schema.Number,
  is_preferred: Schema.Boolean,
})

export const LogicalOutputSchema = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
  scale: Schema.Number,
  transform: TransformSchema,
})

export const OutputSchema = Schema.Struct({
  name: Schema.String,
  make: Schema.String,
  model: Schema.String,
  serial: NullableStringSchema,
  physical_size: Schema.NullOr(PairIntegerSchema),
  modes: Schema.Array(ModeSchema),
  current_mode: NullableNumberSchema,
  is_custom_mode: Schema.Boolean,
  vrr_supported: Schema.Boolean,
  vrr_enabled: Schema.Boolean,
  logical: Schema.NullOr(LogicalOutputSchema),
})

export const OutputsSchema = Schema.Record(Schema.String, OutputSchema)
export const FocusedOutputSchema = Schema.NullOr(OutputSchema)

export const LayerSchema = Schema.Literals(["Background", "Bottom", "Top", "Overlay"])
export const LayerSurfaceKeyboardInteractivitySchema = Schema.Literals([
  "None",
  "Exclusive",
  "OnDemand",
])

export const LayerSurfaceSchema = Schema.Struct({
  namespace: Schema.String,
  output: Schema.String,
  layer: LayerSchema,
  keyboard_interactivity: LayerSurfaceKeyboardInteractivitySchema,
})

export const LayersSchema = Schema.Array(LayerSurfaceSchema)

export const KeyboardLayoutsSchema = Schema.Struct({
  names: Schema.Array(Schema.String),
  current_idx: Schema.Number,
})

export const OverviewSchema = Schema.Struct({
  is_open: Schema.Boolean,
})

export const PickedColorSchema = Schema.NullOr(
  Schema.Struct({
    rgb: Schema.Tuple([Schema.Number, Schema.Number, Schema.Number]),
  }),
)

export const VersionSchema = Schema.Struct({
  cli: Schema.String,
  compositor: Schema.String,
})

export const OutputConfigChangedSchema = Schema.Literals(["Applied", "OutputWasMissing"])

const CastKindSchema = Schema.Literals(["PipeWire", "WlrScreencopy"])
const CastTargetSchema = Schema.Union([
  Schema.Struct({ Nothing: Schema.Struct({}) }),
  Schema.Struct({ Output: Schema.Struct({ name: Schema.String }) }),
  Schema.Struct({ Window: Schema.Struct({ id: Schema.Number }) }),
])

const CastSchema = Schema.Struct({
  stream_id: Schema.Number,
  session_id: Schema.Number,
  kind: CastKindSchema,
  target: CastTargetSchema,
  is_dynamic_target: Schema.Boolean,
  is_active: Schema.Boolean,
  pid: NullableNumberSchema,
  pw_node_id: NullableNumberSchema,
})

const eventSchemas = {
  WorkspacesChanged: Schema.Struct({ workspaces: WorkspacesSchema }),
  WorkspaceUrgencyChanged: Schema.Struct({ id: Schema.Number, urgent: Schema.Boolean }),
  WorkspaceActivated: Schema.Struct({ id: Schema.Number, focused: Schema.Boolean }),
  WorkspaceActiveWindowChanged: Schema.Struct({
    workspace_id: Schema.Number,
    active_window_id: NullableNumberSchema,
  }),
  WindowsChanged: Schema.Struct({ windows: WindowsSchema }),
  WindowOpenedOrChanged: Schema.Struct({ window: WindowSchema }),
  WindowClosed: Schema.Struct({ id: Schema.Number }),
  WindowFocusChanged: Schema.Struct({ id: NullableNumberSchema }),
  WindowFocusTimestampChanged: Schema.Struct({
    id: Schema.Number,
    focus_timestamp: Schema.NullOr(TimestampSchema),
  }),
  WindowUrgencyChanged: Schema.Struct({ id: Schema.Number, urgent: Schema.Boolean }),
  WindowLayoutsChanged: Schema.Struct({
    changes: Schema.Array(Schema.Tuple([Schema.Number, WindowLayoutSchema])),
  }),
  KeyboardLayoutsChanged: Schema.Struct({ keyboard_layouts: KeyboardLayoutsSchema }),
  KeyboardLayoutSwitched: Schema.Struct({ idx: Schema.Number }),
  OverviewOpenedOrClosed: Schema.Struct({ is_open: Schema.Boolean }),
  ConfigLoaded: Schema.Struct({ failed: Schema.Boolean }),
  ScreenshotCaptured: Schema.Struct({ path: NullableStringSchema }),
  CastsChanged: Schema.Struct({ casts: Schema.Array(CastSchema) }),
  CastStartedOrChanged: Schema.Struct({ cast: CastSchema }),
  CastStopped: Schema.Struct({ stream_id: Schema.Number }),
} as const

type EventSchemas = typeof eventSchemas
type EventPayload<Name extends keyof EventSchemas> = Schema.Schema.Type<EventSchemas[Name]>

export type NiriEvent = {
  readonly [Name in keyof EventSchemas]: { readonly type: Name } & EventPayload<Name>
}[keyof EventSchemas]

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const decodeEventVariant = <Name extends string, S extends Schema.Decoder<unknown>>(
  name: Name,
  schema: S,
  value: unknown,
  payload: string,
): Effect.Effect<{ readonly type: Name } & S["Type"], NiriDecodeError> =>
  Effect.gen(function* () {
    const decoded = yield* Schema.decodeUnknownEffect(schema)(value).pipe(
      Effect.mapError(
        (cause) =>
          new NiriDecodeError({
            message: `Malformed Niri ${name} event JSON`,
            payload,
            cause,
          }),
      ),
    )

    return Object.assign({ type: name }, decoded)
  })

export const decodeNiriJson = <S extends Schema.Decoder<unknown>>(
  label: string,
  schema: S,
  payload: string,
): Effect.Effect<S["Type"], NiriDecodeError> =>
  Effect.gen(function* () {
    const parsed = yield* Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(payload).pipe(
      Effect.mapError(
        (cause) =>
          new NiriDecodeError({
            message: `Failed to parse Niri ${label} JSON`,
            payload,
            cause,
          }),
      ),
    )

    return yield* Schema.decodeUnknownEffect(schema)(parsed).pipe(
      Effect.mapError(
        (cause) =>
          new NiriDecodeError({
            message: `Malformed Niri ${label} JSON`,
            payload,
            cause,
          }),
      ),
    )
  })

export const decodeNiriEventJson = (payload: string): Effect.Effect<NiriEvent, NiriDecodeError> =>
  Effect.gen(function* () {
    const parsed = yield* Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(payload).pipe(
      Effect.mapError(
        (cause) =>
          new NiriDecodeError({
            message: "Failed to parse Niri event JSON",
            payload,
            cause,
          }),
      ),
    )

    if (!isRecord(parsed)) {
      return yield* new NiriDecodeError({
        message: "Malformed Niri event JSON: expected single event object",
        payload,
      })
    }

    const entries = Object.entries(parsed)
    if (entries.length !== 1) {
      return yield* new NiriDecodeError({
        message: "Malformed Niri event JSON: expected exactly one event variant",
        payload,
      })
    }

    const entry = entries[0]
    if (entry === undefined) {
      return yield* new NiriDecodeError({
        message: "Malformed Niri event JSON: expected exactly one event variant",
        payload,
      })
    }

    const [name, value] = entry
    switch (name) {
      case "WorkspacesChanged":
        return yield* decodeEventVariant(name, eventSchemas.WorkspacesChanged, value, payload)
      case "WorkspaceUrgencyChanged":
        return yield* decodeEventVariant(name, eventSchemas.WorkspaceUrgencyChanged, value, payload)
      case "WorkspaceActivated":
        return yield* decodeEventVariant(name, eventSchemas.WorkspaceActivated, value, payload)
      case "WorkspaceActiveWindowChanged":
        return yield* decodeEventVariant(
          name,
          eventSchemas.WorkspaceActiveWindowChanged,
          value,
          payload,
        )
      case "WindowsChanged":
        return yield* decodeEventVariant(name, eventSchemas.WindowsChanged, value, payload)
      case "WindowOpenedOrChanged":
        return yield* decodeEventVariant(name, eventSchemas.WindowOpenedOrChanged, value, payload)
      case "WindowClosed":
        return yield* decodeEventVariant(name, eventSchemas.WindowClosed, value, payload)
      case "WindowFocusChanged":
        return yield* decodeEventVariant(name, eventSchemas.WindowFocusChanged, value, payload)
      case "WindowFocusTimestampChanged":
        return yield* decodeEventVariant(
          name,
          eventSchemas.WindowFocusTimestampChanged,
          value,
          payload,
        )
      case "WindowUrgencyChanged":
        return yield* decodeEventVariant(name, eventSchemas.WindowUrgencyChanged, value, payload)
      case "WindowLayoutsChanged":
        return yield* decodeEventVariant(name, eventSchemas.WindowLayoutsChanged, value, payload)
      case "KeyboardLayoutsChanged":
        return yield* decodeEventVariant(name, eventSchemas.KeyboardLayoutsChanged, value, payload)
      case "KeyboardLayoutSwitched":
        return yield* decodeEventVariant(name, eventSchemas.KeyboardLayoutSwitched, value, payload)
      case "OverviewOpenedOrClosed":
        return yield* decodeEventVariant(name, eventSchemas.OverviewOpenedOrClosed, value, payload)
      case "ConfigLoaded":
        return yield* decodeEventVariant(name, eventSchemas.ConfigLoaded, value, payload)
      case "ScreenshotCaptured":
        return yield* decodeEventVariant(name, eventSchemas.ScreenshotCaptured, value, payload)
      case "CastsChanged":
        return yield* decodeEventVariant(name, eventSchemas.CastsChanged, value, payload)
      case "CastStartedOrChanged":
        return yield* decodeEventVariant(name, eventSchemas.CastStartedOrChanged, value, payload)
      case "CastStopped":
        return yield* decodeEventVariant(name, eventSchemas.CastStopped, value, payload)
      default:
        return yield* new NiriDecodeError({
          message: `Unsupported Niri event variant: ${name}`,
          payload,
        })
    }
  })

export type NiriVersion = Schema.Schema.Type<typeof VersionSchema>
export type NiriOutput = Schema.Schema.Type<typeof OutputSchema>
export type NiriWorkspace = Schema.Schema.Type<typeof WorkspaceSchema>
export type NiriWindow = Schema.Schema.Type<typeof WindowSchema>
export type NiriLayerSurface = Schema.Schema.Type<typeof LayerSurfaceSchema>
export type NiriKeyboardLayouts = Schema.Schema.Type<typeof KeyboardLayoutsSchema>
export type NiriOverview = Schema.Schema.Type<typeof OverviewSchema>
export type NiriPickedColor = Schema.Schema.Type<typeof PickedColorSchema>
export type NiriOutputConfigChanged = Schema.Schema.Type<typeof OutputConfigChangedSchema>
