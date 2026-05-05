import { Console, Effect, Ref } from "effect"
import * as path from "node:path"
import { mkdir as mkdirNode, writeFile as writeNodeFile } from "node:fs/promises"

import { EFFECT_PI_RUNTIME_DIR } from "../../paths.js"
import { CliError } from "../shared.js"

export const ASSISTANT_RECORDING_STATE_PATH = path.join(EFFECT_PI_RUNTIME_DIR, "recording.json")

export type AssistantRecordingMode = "ptt-transcribe" | "ptt-translate" | "wakeword"

export type AssistantRecordingState = {
  readonly active: boolean
  readonly mode: AssistantRecordingMode | "idle"
  readonly startedAt: string | null
  readonly updatedAt: string
}

export type AssistantRecordingRuntimeState = {
  readonly mode: AssistantRecordingMode | undefined
  readonly startedAtMs: number | undefined
}

export const persistAssistantRecordingState = (
  state: AssistantRecordingState,
): Effect.Effect<void, CliError> =>
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
        message: `Failed to write assistant recording state at ${ASSISTANT_RECORDING_STATE_PATH}`,
        cause,
      }),
  })

export const setAssistantRecordingMode = (config: {
  readonly ref: Ref.Ref<AssistantRecordingRuntimeState>
  readonly mode: AssistantRecordingMode | undefined
}): Effect.Effect<void, CliError> =>
  Effect.gen(function* () {
    const nowMs = Date.now()
    const nowIso = new Date(nowMs).toISOString()

    const state = yield* Ref.modify(config.ref, (current) => {
      if (config.mode === undefined) {
        const nextState: AssistantRecordingState = {
          active: false,
          mode: "idle",
          startedAt: null,
          updatedAt: nowIso,
        }

        const nextRuntime: AssistantRecordingRuntimeState = {
          mode: undefined,
          startedAtMs: undefined,
        }

        return [nextState, nextRuntime] as const
      }

      const startedAtMs =
        current.mode === config.mode && current.startedAtMs !== undefined
          ? current.startedAtMs
          : nowMs

      const nextState: AssistantRecordingState = {
        active: true,
        mode: config.mode,
        startedAt: new Date(startedAtMs).toISOString(),
        updatedAt: nowIso,
      }

      const nextRuntime: AssistantRecordingRuntimeState = {
        mode: config.mode,
        startedAtMs,
      }

      return [nextState, nextRuntime] as const
    })

    yield* persistAssistantRecordingState(state).pipe(
      Effect.tapError((cause: CliError) => Console.log(`[assistant] ${cause.message}`)),
    )
  })
