import { Console, Effect, Ref } from "effect"
import * as path from "node:path"
import { mkdir as mkdirNode, writeFile as writeNodeFile } from "node:fs/promises"

import { EFFECT_PI_RUNTIME_DIR } from "../../paths.js"
import { CliError } from "../shared.js"

export const ASSISTANT_RECORDING_STATE_PATH = path.join(EFFECT_PI_RUNTIME_DIR, "recording.json")

export type RecordingMode = "ptt-transcribe" | "ptt-translate" | "wakeword" | "meeting-transcribe"

export type RecordingState = {
  readonly enabled: boolean
  readonly active: boolean
  readonly mode: RecordingMode | "idle"
  readonly startedAt: string | null
  readonly updatedAt: string
  readonly transcriptPath: string | null
  readonly lastError: string | null
}

export type RecordingRuntimeState = {
  readonly enabled: boolean
  readonly mode: RecordingMode | undefined
  readonly startedAtMs: number | undefined
  readonly transcriptPath: string | undefined
  readonly lastError: string | undefined
}

export type StartRecordingResult =
  | { readonly _tag: "Started"; readonly mode: RecordingMode }
  | { readonly _tag: "Busy"; readonly activeMode: RecordingMode }
  | { readonly _tag: "Disabled" }

export const persistRecordingState = (state: RecordingState): Effect.Effect<void, CliError> =>
  Effect.tryPromise({
    try: async () => {
      await mkdirNode(path.dirname(ASSISTANT_RECORDING_STATE_PATH), { recursive: true })
      await writeNodeFile(
        ASSISTANT_RECORDING_STATE_PATH,
        `${JSON.stringify(state, null, 2)}\n`,
        "utf8",
      )
    },
    catch: (cause) =>
      new CliError({
        message: `Failed to write recording state at ${ASSISTANT_RECORDING_STATE_PATH}`,
        cause,
      }),
  })

const buildRecordingState = (runtime: RecordingRuntimeState): RecordingState => ({
  enabled: runtime.enabled,
  active: runtime.mode !== undefined,
  mode: runtime.mode ?? "idle",
  startedAt: runtime.startedAtMs !== undefined ? new Date(runtime.startedAtMs).toISOString() : null,
  updatedAt: new Date().toISOString(),
  transcriptPath: runtime.transcriptPath ?? null,
  lastError: runtime.lastError ?? null,
})

export const tryStartRecording = (config: {
  readonly ref: Ref.Ref<RecordingRuntimeState>
  readonly mode: RecordingMode
  readonly transcriptPath?: string | undefined
}): Effect.Effect<StartRecordingResult, CliError> =>
  Effect.gen(function* () {
    const result = yield* Ref.modify(config.ref, (current) => {
      if (!current.enabled) {
        const nextRuntime: RecordingRuntimeState = {
          ...current,
          lastError: undefined,
        }
        return [{ _tag: "Disabled" } as StartRecordingResult, nextRuntime] as const
      }

      if (current.mode !== undefined) {
        const nextRuntime: RecordingRuntimeState = {
          ...current,
          lastError: undefined,
        }
        return [
          { _tag: "Busy", activeMode: current.mode } as StartRecordingResult,
          nextRuntime,
        ] as const
      }

      const nowMs = Date.now()
      const nextRuntime: RecordingRuntimeState = {
        enabled: current.enabled,
        mode: config.mode,
        startedAtMs: nowMs,
        transcriptPath: config.transcriptPath,
        lastError: undefined,
      }
      return [{ _tag: "Started", mode: config.mode } as StartRecordingResult, nextRuntime] as const
    })

    const runtime = yield* Ref.get(config.ref)
    yield* persistRecordingState(buildRecordingState(runtime)).pipe(
      Effect.tapError((cause: CliError) => Console.log(`[coordinator] ${cause.message}`)),
    )

    return result
  })

export const stopRecording = (config: {
  readonly ref: Ref.Ref<RecordingRuntimeState>
  readonly mode: RecordingMode
}): Effect.Effect<boolean, CliError> =>
  Effect.gen(function* () {
    const didStop = yield* Ref.modify(config.ref, (current) => {
      if (current.mode !== config.mode) {
        return [false, current] as const
      }

      const nextRuntime: RecordingRuntimeState = {
        enabled: current.enabled,
        mode: undefined,
        startedAtMs: undefined,
        transcriptPath: undefined,
        lastError: undefined,
      }
      return [true, nextRuntime] as const
    })

    const runtime = yield* Ref.get(config.ref)
    yield* persistRecordingState(buildRecordingState(runtime)).pipe(
      Effect.tapError((cause: CliError) => Console.log(`[coordinator] ${cause.message}`)),
    )

    return didStop
  })

export const setRecordingEnabled = (config: {
  readonly ref: Ref.Ref<RecordingRuntimeState>
  readonly enabled: boolean
}): Effect.Effect<void, CliError> =>
  Effect.gen(function* () {
    const runtime = yield* Ref.modify(config.ref, (current) => {
      const nextRuntime: RecordingRuntimeState = {
        ...current,
        enabled: config.enabled,
      }
      return [nextRuntime, nextRuntime] as const
    })

    yield* persistRecordingState(buildRecordingState(runtime)).pipe(
      Effect.tapError((cause: CliError) => Console.log(`[coordinator] ${cause.message}`)),
    )
  })

export const setRecordingError = (config: {
  readonly ref: Ref.Ref<RecordingRuntimeState>
  readonly lastError: string
}): Effect.Effect<void, CliError> =>
  Effect.gen(function* () {
    const runtime = yield* Ref.modify(config.ref, (current) => {
      const nextRuntime: RecordingRuntimeState = {
        ...current,
        lastError: config.lastError,
      }
      return [nextRuntime, nextRuntime] as const
    })

    yield* persistRecordingState(buildRecordingState(runtime)).pipe(
      Effect.tapError((cause: CliError) => Console.log(`[coordinator] ${cause.message}`)),
    )
  })

export const getRecordingState = (config: {
  readonly ref: Ref.Ref<RecordingRuntimeState>
}): Effect.Effect<RecordingState> =>
  Effect.gen(function* () {
    const runtime = yield* Ref.get(config.ref)
    return buildRecordingState(runtime)
  })

// Legacy aliases for backward compatibility during migration
export type AssistantRecordingMode = RecordingMode
export type AssistantRecordingState = RecordingState
export type AssistantRecordingRuntimeState = RecordingRuntimeState

export const setAssistantRecordingEnabled = setRecordingEnabled
export const setAssistantRecordingMode = (config: {
  readonly ref: Ref.Ref<RecordingRuntimeState>
  readonly mode: RecordingMode | undefined
}): Effect.Effect<void, CliError> =>
  Effect.gen(function* () {
    const nowMs = Date.now()
    const nowIso = new Date(nowMs).toISOString()

    const state = yield* Ref.modify(config.ref, (current) => {
      if (config.mode === undefined) {
        const nextState: RecordingState = {
          enabled: current.enabled,
          active: false,
          mode: "idle",
          startedAt: null,
          updatedAt: nowIso,
          transcriptPath: current.transcriptPath ?? null,
          lastError: current.lastError ?? null,
        }
        const nextRuntime: RecordingRuntimeState = {
          enabled: current.enabled,
          mode: undefined,
          startedAtMs: undefined,
          transcriptPath: current.transcriptPath,
          lastError: current.lastError,
        }
        return [nextState, nextRuntime] as const
      }

      const startedAtMs =
        current.mode === config.mode && current.startedAtMs !== undefined
          ? current.startedAtMs
          : nowMs

      const nextState: RecordingState = {
        enabled: current.enabled,
        active: true,
        mode: config.mode,
        startedAt: new Date(startedAtMs).toISOString(),
        updatedAt: nowIso,
        transcriptPath: current.transcriptPath ?? null,
        lastError: current.lastError ?? null,
      }
      const nextRuntime: RecordingRuntimeState = {
        enabled: current.enabled,
        mode: config.mode,
        startedAtMs,
        transcriptPath: current.transcriptPath,
        lastError: current.lastError,
      }
      return [nextState, nextRuntime] as const
    })

    yield* persistRecordingState(state).pipe(
      Effect.tapError((cause: CliError) => Console.log(`[coordinator] ${cause.message}`)),
    )
  })
