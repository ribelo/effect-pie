import { Console, Effect, Layer, Option, Ref } from "effect"
import { loadSttRuntimeConfig, type SttConfigError } from "../stt/config.js"
import { SttService } from "../stt/service.js"
import { Niri } from "../niri/service.js"
import { PulseAudioClient } from "../pulse/client.js"
import type { KeyboardMonitorService, PttKeyboardError } from "../keyboard/monitor.js"
import type { TextInjectionBackendService } from "../input/textInjection.js"
import type { DesktopSession } from "../desktop/session.js"
import { AssistantDiagnostics, isShellTraceEnabled } from "../assistant/diagnostics.js"
import { CliError } from "./shared.js"
import {
  setAssistantRecordingMode,
  setAssistantRecordingEnabled,
  ASSISTANT_RECORDING_STATE_PATH,
  type AssistantRecordingMode,
  type AssistantRecordingRuntimeState,
} from "./assistant/recordingState.js"
import { startDaemonServer } from "./daemon.js"
import {
  DEFAULT_ASSISTANT_WAKEWORD_MODEL_FILE,
  DEFAULT_ASSISTANT_PTT_TRANSCRIBE_KEYSYM,
  DEFAULT_ASSISTANT_PTT_TRANSLATE_KEYSYM,
  resolveWakewordSpeechStartTimeoutSeconds,
} from "./assistant/constants.js"
import { runAssistantWakewordTranscribeLoop } from "./assistant/wakewordLoop.js"
import { runAssistantPttCombinedLoop } from "./assistant/pttLoop.js"

const resolveDefaultSourceName = (): Effect.Effect<string, CliError, PulseAudioClient> =>
  Effect.gen(function* () {
    const client = yield* PulseAudioClient

    const serverInfo = yield* client.getServerInfo.pipe(
      Effect.mapError(
        (cause) =>
          new CliError({
            message: "Failed to resolve default PulseAudio source",
            cause,
          }),
      ),
    )

    if (serverInfo.defaultSource === null || serverInfo.defaultSource.length === 0) {
      return yield* new CliError({
        message: "PulseAudio did not return a default capture source",
      })
    }

    return serverInfo.defaultSource
  })

export const runAssistantDefaultCommand = Effect.fn(
  "pie/commands/assistant.runAssistantDefaultCommand",
)(function* (config: {
  readonly "ptt-transcribe-keysym": Option.Option<number>
  readonly "ptt-translate-keysym": Option.Option<number>
}): Effect.fn.Return<
  void,
  CliError | SttConfigError | PttKeyboardError | Error,
  PulseAudioClient | KeyboardMonitorService | DesktopSession | TextInjectionBackendService
> {
  const sttConfig = yield* loadSttRuntimeConfig().pipe(
    Effect.mapError(
      (cause: SttConfigError) =>
        new CliError({
          message: `Failed to load STT config: ${cause.message}`,
          cause,
        }),
    ),
  )

  const sourceName = yield* resolveDefaultSourceName()
  yield* Console.log("[assistant] Running default assistant mode")
  if (sttConfig.wakewordEnabled) {
    yield* Console.log(
      `[assistant] Wakeword model=${DEFAULT_ASSISTANT_WAKEWORD_MODEL_FILE} -> transcription (${sttConfig.transcriptionLanguage})`,
    )
  } else {
    yield* Console.log("[assistant] Wakeword disabled (PTT-only mode)")
  }
  yield* Console.log(
    `[assistant] PTT transcribe keysym=${Option.getOrElse(config["ptt-transcribe-keysym"], () => DEFAULT_ASSISTANT_PTT_TRANSCRIBE_KEYSYM)}, PTT translate keysym=${Option.getOrElse(config["ptt-translate-keysym"], () => DEFAULT_ASSISTANT_PTT_TRANSLATE_KEYSYM)}`,
  )
  if (sttConfig.wakewordEnabled) {
    yield* Console.log(
      `[assistant] Wakeword dictation: silence=${sttConfig.wakewordDictationSilenceSeconds}s max=${sttConfig.wakewordDictationMaxSeconds}s speech_start_timeout=${resolveWakewordSpeechStartTimeoutSeconds(
        {
          silenceSeconds: sttConfig.wakewordDictationSilenceSeconds,
          maxSeconds: sttConfig.wakewordDictationMaxSeconds,
        },
      )}s speech_rms=${sttConfig.wakewordDictationSpeechRmsThreshold.toFixed(4)}`,
    )
  }
  yield* Console.log("[assistant] Focus the target app (for example Slack) to receive typed text")
  yield* Console.log("[assistant] Press Ctrl+C to stop all listeners")

  const pttActiveRef = yield* Ref.make(false)
  const recordingStateRef = yield* Ref.make<AssistantRecordingRuntimeState>({
    enabled: true,
    mode: undefined,
    startedAtMs: undefined,
  })
  const setRecordingMode = (mode: AssistantRecordingMode | undefined) =>
    setAssistantRecordingMode({
      ref: recordingStateRef,
      mode,
    })

  yield* setRecordingMode(undefined)
  yield* setAssistantRecordingEnabled({ ref: recordingStateRef, enabled: true })
  yield* Console.log(`[assistant] Recording state file: ${ASSISTANT_RECORDING_STATE_PATH}`)

  const shellTraceEnabled = yield* Effect.sync(() =>
    isShellTraceEnabled(process.env["PIE_SHELL_TRACE"]),
  )
  const diagnostics = shellTraceEnabled ? new AssistantDiagnostics() : undefined

  const effect = Effect.scoped(
    Effect.gen(function* () {
      yield* startDaemonServer({ ref: recordingStateRef }).pipe(Effect.forkScoped)

      yield* Effect.all(
        [
          runAssistantPttCombinedLoop({
            sourceName,
            sttConfig,
            pttActiveRef,
            setRecordingMode,
            diagnostics,
            pttTranscribeKeysym: config["ptt-transcribe-keysym"],
            pttTranslateKeysym: config["ptt-translate-keysym"],
            recordingStateRef,
          }),
          ...(sttConfig.wakewordEnabled
            ? [
                runAssistantWakewordTranscribeLoop({
                  sourceName,
                  sttConfig,
                  pttActiveRef,
                  setRecordingMode,
                  diagnostics,
                  recordingStateRef,
                }),
              ]
            : []),
        ],
        {
          concurrency: "unbounded",
          discard: true,
        },
      )
    }),
  ).pipe(Effect.onExit(() => setRecordingMode(undefined)))

  return yield* effect.pipe(
    Effect.provide(Layer.mergeAll(SttService.live(sttConfig), Niri.live)),
    Effect.tapError((cause) =>
      Effect.gen(function* () {
        if (diagnostics !== undefined) {
          diagnostics.setState("idle")
          yield* Console.error(diagnostics.renderSnapshot())
        }
      }),
    ),
  )
})
