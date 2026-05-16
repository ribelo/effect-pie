import { Effect, Layer, Option } from "effect"
import { loadSttRuntimeConfig, type SttConfigError } from "../stt/config.js"
import { SttService } from "../stt/service.js"
import { Niri } from "../niri/niri.js"
import { PulseAudioClient } from "../pulse/client.js"
import type { KeyboardMonitorService, PttKeyboardError } from "../keyboard/monitor.js"
import type { TextInjectionBackendService } from "../input/textInjection.js"
import type { DesktopSession } from "../desktop/session.js"

import { CliError } from "./shared.js"
import { ASSISTANT_RECORDING_STATE_PATH, RecordingCoordinator } from "./assistant/coordinator.js"
import { DaemonRpcServer } from "../daemon/server.js"
import {
  DEFAULT_ASSISTANT_WAKEWORD_MODEL_FILE,
  DEFAULT_ASSISTANT_PTT_TRANSCRIBE_KEYSYM,
  DEFAULT_ASSISTANT_PTT_TRANSLATE_KEYSYM,
  resolveWakewordSpeechStartTimeoutSeconds,
} from "./assistant/constants.js"
import { runAssistantWakewordTranscribeLoop } from "./assistant/wakewordLoop.js"
import { runAssistantPttCombinedLoop } from "./assistant/pttLoop.js"
import { MeetingTranscriptionController } from "./assistant/meetingTranscription.js"

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
  yield* Effect.logInfo("Running default assistant mode").pipe(
    Effect.annotateLogs({
      "assistant.wakeword_enabled": sttConfig.wakewordEnabled,
      "assistant.ptt_transcribe_keysym": Option.getOrElse(
        config["ptt-transcribe-keysym"],
        () => DEFAULT_ASSISTANT_PTT_TRANSCRIBE_KEYSYM,
      ),
      "assistant.ptt_translate_keysym": Option.getOrElse(
        config["ptt-translate-keysym"],
        () => DEFAULT_ASSISTANT_PTT_TRANSLATE_KEYSYM,
      ),
    }),
  )
  if (sttConfig.wakewordEnabled) {
    yield* Effect.logInfo("Wakeword enabled").pipe(
      Effect.annotateLogs({
        "assistant.wakeword_model": DEFAULT_ASSISTANT_WAKEWORD_MODEL_FILE,
        "assistant.transcription_language": sttConfig.transcriptionLanguage,
        "assistant.dictation_silence_seconds": sttConfig.wakewordDictationSilenceSeconds,
        "assistant.dictation_max_seconds": sttConfig.wakewordDictationMaxSeconds,
        "assistant.speech_start_timeout_seconds": resolveWakewordSpeechStartTimeoutSeconds({
          silenceSeconds: sttConfig.wakewordDictationSilenceSeconds,
          maxSeconds: sttConfig.wakewordDictationMaxSeconds,
        }),
        "assistant.dictation_speech_rms_threshold": sttConfig.wakewordDictationSpeechRmsThreshold,
      }),
    )
  } else {
    yield* Effect.logInfo("Wakeword disabled (PTT-only mode)")
  }

  const effect = Effect.scoped(
    Effect.gen(function* () {
      const coordinator = yield* RecordingCoordinator
      yield* coordinator.clear
      yield* Effect.logInfo("Recording state file ready").pipe(
        Effect.annotateLogs({ "assistant.recording_state_path": ASSISTANT_RECORDING_STATE_PATH }),
      )

      // DaemonRpcServer.layer is provided in the outer Layer.mergeAll

      yield* Effect.all(
        [
          runAssistantPttCombinedLoop({
            sourceName,
            sttConfig,
            pttTranscribeKeysym: config["ptt-transcribe-keysym"],
            pttTranslateKeysym: config["ptt-translate-keysym"],
          }),
          ...(sttConfig.wakewordEnabled
            ? [
                runAssistantWakewordTranscribeLoop({
                  sourceName,
                  sttConfig,
                }),
              ]
            : []),
        ],
        {
          concurrency: "unbounded",
          discard: true,
        },
      )
    }).pipe(
      Effect.onExit(() =>
        Effect.gen(function* () {
          const coordinator = yield* RecordingCoordinator
          yield* coordinator.clear
        }),
      ),
      Effect.onError((cause) =>
        Effect.gen(function* () {
          const coordinator = yield* RecordingCoordinator
          const snapshot = yield* coordinator.snapshot
          yield* Effect.logError("Assistant exited with error").pipe(
            Effect.annotateLogs({
              "assistant.last_mode": snapshot.mode,
              "assistant.last_active": snapshot.active,
              "assistant.last_enabled": snapshot.enabled,
              "assistant.cause": String(cause),
            }),
          )
        }),
      ),
    ),
  )

  const sttLayer = SttService.live(sttConfig)
  const coordinatorLayer = RecordingCoordinator.live()
  const meetingLayer = MeetingTranscriptionController.live({ sttConfig }).pipe(
    Layer.provideMerge(Layer.mergeAll(sttLayer, coordinatorLayer)),
  )
  const daemonLayer = DaemonRpcServer.layer().pipe(Layer.provideMerge(meetingLayer))

  return yield* effect.pipe(
    Effect.provide(Layer.mergeAll(Niri.live(), daemonLayer)),
    Effect.catchTag("SocketPreflightError", (err) =>
      Effect.fail(
        new CliError({
          message: `Daemon socket preflight failed: ${err.message}`,
          cause: err,
        }),
      ),
    ),
  )
})
