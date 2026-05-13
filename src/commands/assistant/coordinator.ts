import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import * as path from "node:path"
import { mkdir as mkdirNode, writeFile as writeNodeFile } from "node:fs/promises"

import { EFFECT_PI_RUNTIME_DIR } from "../../paths.js"

export const ASSISTANT_RECORDING_STATE_PATH = path.join(EFFECT_PI_RUNTIME_DIR, "recording.json")

export const RecordingModeSchema = Schema.Union([
  Schema.Literal("ptt-transcribe"),
  Schema.Literal("ptt-translate"),
  Schema.Literal("wakeword"),
  Schema.Literal("meeting-transcribe"),
])
export type RecordingMode = typeof RecordingModeSchema.Type

export const RecordingSnapshotSchema = Schema.Struct({
  enabled: Schema.Boolean,
  active: Schema.Boolean,
  mode: Schema.Union([
    Schema.Literal("ptt-transcribe"),
    Schema.Literal("ptt-translate"),
    Schema.Literal("wakeword"),
    Schema.Literal("meeting-transcribe"),
    Schema.Literal("idle"),
  ]),
  startedAt: Schema.Union([Schema.String, Schema.Null]),
  updatedAt: Schema.String,
  transcriptPath: Schema.Union([Schema.String, Schema.Null]),
  lastError: Schema.Union([Schema.String, Schema.Null]),
})
export type RecordingSnapshot = typeof RecordingSnapshotSchema.Type

export const StartResultSchema = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("Started"),
    mode: RecordingModeSchema,
  }),
  Schema.Struct({
    _tag: Schema.Literal("Busy"),
    activeMode: RecordingModeSchema,
  }),
  Schema.Struct({
    _tag: Schema.Literal("Disabled"),
  }),
])
export type StartResult = typeof StartResultSchema.Type

export class RecordingPersistError extends Data.TaggedError("RecordingPersistError")<{
  readonly message: string
  readonly persistPath: string
  readonly cause?: unknown
}> {}

type InternalState = {
  readonly enabled: boolean
  readonly mode: RecordingMode | undefined
  readonly startedAtMs: number | undefined
  readonly transcriptPath: string | undefined
  readonly lastError: string | undefined
  readonly updatedAtMs: number
}

const initialState = (nowMs: number): InternalState => ({
  enabled: true,
  mode: undefined,
  startedAtMs: undefined,
  transcriptPath: undefined,
  lastError: undefined,
  updatedAtMs: nowMs,
})

const toSnapshot = (state: InternalState): RecordingSnapshot => ({
  enabled: state.enabled,
  active: state.mode !== undefined,
  mode: state.mode ?? "idle",
  startedAt: state.startedAtMs !== undefined ? new Date(state.startedAtMs).toISOString() : null,
  updatedAt: new Date(state.updatedAtMs).toISOString(),
  transcriptPath: state.transcriptPath ?? null,
  lastError: state.lastError ?? null,
})

export class RecordingCoordinator extends Context.Service<
  RecordingCoordinator,
  {
    readonly snapshot: Effect.Effect<RecordingSnapshot>
    readonly tryStart: (
      mode: RecordingMode,
      options?: { readonly transcriptPath?: string | undefined },
    ) => Effect.Effect<StartResult>
    readonly stop: (mode: RecordingMode) => Effect.Effect<boolean>
    readonly setEnabled: (enabled: boolean) => Effect.Effect<void>
    readonly toggleEnabled: Effect.Effect<boolean>
    readonly toggleMeeting: Effect.Effect<RecordingSnapshot>
    readonly setError: (message: string) => Effect.Effect<void>
    readonly clear: Effect.Effect<void>
  }
>()("pie/commands/assistant/RecordingCoordinator") {
  static readonly live = (options?: {
    readonly persistPath?: string
  }): Layer.Layer<RecordingCoordinator> =>
    Layer.effect(RecordingCoordinator)(
      Effect.gen(function* () {
        const persistPath = options?.persistPath ?? ASSISTANT_RECORDING_STATE_PATH
        const ref = yield* Ref.make<InternalState>(initialState(Date.now()))

        const writeSnapshot = (snapshot: RecordingSnapshot) =>
          Effect.tryPromise({
            try: async () => {
              await mkdirNode(path.dirname(persistPath), { recursive: true })
              await writeNodeFile(persistPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8")
            },
            catch: (cause) =>
              new RecordingPersistError({
                message: `Failed to write recording state at ${persistPath}`,
                persistPath,
                cause,
              }),
          })

        const persist = (snapshot: RecordingSnapshot) =>
          writeSnapshot(snapshot).pipe(
            Effect.tapError((cause) =>
              Effect.logError(cause.message).pipe(Effect.annotateLogs({ cause })),
            ),
            Effect.ignore,
          )

        const mutate = <A>(update: (current: InternalState) => readonly [A, InternalState]) =>
          Effect.gen(function* () {
            const [result, next] = yield* Ref.modify(
              ref,
              (current): readonly [readonly [A, InternalState], InternalState] => {
                const [value, patched] = update(current)
                return [[value, patched], patched] as const
              },
            )
            yield* persist(toSnapshot(next))
            return result
          })

        const snapshot = Ref.get(ref).pipe(Effect.map(toSnapshot))

        const tryStart = (
          mode: RecordingMode,
          startOptions?: { readonly transcriptPath?: string | undefined },
        ) =>
          mutate<StartResult>((current) => {
            if (!current.enabled) {
              return [{ _tag: "Disabled" }, current]
            }

            if (current.mode !== undefined) {
              return [{ _tag: "Busy", activeMode: current.mode }, current]
            }

            const nowMs = Date.now()
            const next: InternalState = {
              enabled: current.enabled,
              mode,
              startedAtMs: nowMs,
              transcriptPath: startOptions?.transcriptPath,
              lastError: undefined,
              updatedAtMs: nowMs,
            }
            return [{ _tag: "Started", mode }, next]
          })

        const stop = (mode: RecordingMode) =>
          mutate<boolean>((current) => {
            if (current.mode !== mode) {
              return [false, current]
            }

            const nowMs = Date.now()
            const next: InternalState = {
              enabled: current.enabled,
              mode: undefined,
              startedAtMs: undefined,
              transcriptPath: undefined,
              lastError: undefined,
              updatedAtMs: nowMs,
            }
            return [true, next]
          })

        const setEnabled = (enabled: boolean) =>
          mutate<void>((current) => {
            const next: InternalState = {
              ...current,
              enabled,
              updatedAtMs: Date.now(),
            }
            return [undefined, next]
          })

        const toggleEnabled = mutate<boolean>((current) => {
          const nextEnabled = !current.enabled
          const next: InternalState = {
            ...current,
            enabled: nextEnabled,
            updatedAtMs: Date.now(),
          }
          return [nextEnabled, next]
        })

        const toggleMeeting = mutate<RecordingSnapshot>((current) => {
          const nowMs = Date.now()
          if (current.mode === "meeting-transcribe") {
            const next: InternalState = {
              enabled: current.enabled,
              mode: undefined,
              startedAtMs: undefined,
              transcriptPath: undefined,
              lastError: current.lastError,
              updatedAtMs: nowMs,
            }
            return [toSnapshot(next), next]
          }

          if (current.mode === undefined && current.enabled) {
            const next: InternalState = {
              enabled: current.enabled,
              mode: "meeting-transcribe",
              startedAtMs: nowMs,
              transcriptPath: undefined,
              lastError: undefined,
              updatedAtMs: nowMs,
            }
            return [toSnapshot(next), next]
          }

          return [toSnapshot(current), current]
        })

        const setError = (message: string) =>
          mutate<void>((current) => {
            const next: InternalState = {
              ...current,
              lastError: message,
              updatedAtMs: Date.now(),
            }
            return [undefined, next]
          })

        const clear = mutate<void>((current) => {
          const next: InternalState = {
            enabled: current.enabled,
            mode: undefined,
            startedAtMs: undefined,
            transcriptPath: undefined,
            lastError: undefined,
            updatedAtMs: Date.now(),
          }
          return [undefined, next]
        })

        return RecordingCoordinator.of({
          snapshot,
          tryStart,
          stop,
          setEnabled,
          toggleEnabled,
          toggleMeeting,
          setError,
          clear,
        })
      }),
    )
}
