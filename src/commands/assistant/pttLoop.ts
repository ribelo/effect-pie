import { Console, Effect, Option, Ref } from "effect"

import type { PulseAudioClient } from "../../pulse/client.js"
import type { KeyboardMonitorService, PttKeyboardError } from "../../keyboard/monitor.js"
import type { TextInjectionBackendService } from "../../input/textInjection.js"
import type { DesktopSession } from "../../desktop/session.js"
import type { Niri } from "../../niri/niri.js"
import type { AssistantDiagnostics } from "../../assistant/diagnostics.js"
import type { SttService } from "../../stt/service.js"
import type { SttRuntimeConfig } from "../../stt/config.js"
import { runPttLoop, type PttCaptureHandle } from "../../ptt/loop.js"
import { makeStreamedSttHandle } from "../../ptt/handles.js"
import {
  DEFAULT_ASSISTANT_PTT_TRANSCRIBE_KEYSYM,
  DEFAULT_ASSISTANT_PTT_TRANSLATE_KEYSYM,
  DEFAULT_ASSISTANT_SAMPLE_RATE,
  DEFAULT_ASSISTANT_PTT_FRAGMENT_SIZE,
  DEFAULT_ASSISTANT_MIN_DURATION_MS,
} from "./constants.js"
import { RecordingCoordinator, type RecordingMode } from "./coordinator.js"

type AssistantPttMode = "transcribe" | "translate"

export const runAssistantPttCombinedLoop = (config: {
  readonly sourceName: string
  readonly sttConfig: SttRuntimeConfig
  readonly pttActiveRef: Ref.Ref<boolean>
  readonly diagnostics?: AssistantDiagnostics | undefined
  readonly pttTranscribeKeysym: Option.Option<number>
  readonly pttTranslateKeysym: Option.Option<number>
}): Effect.Effect<
  never,
  PttKeyboardError,
  | PulseAudioClient
  | KeyboardMonitorService
  | DesktopSession
  | Niri
  | TextInjectionBackendService
  | SttService
  | RecordingCoordinator
> =>
  Effect.scoped(
    Effect.gen(function* () {
      const coordinator = yield* RecordingCoordinator

      const transcribeKeysym = Option.getOrElse(
        config.pttTranscribeKeysym,
        () => DEFAULT_ASSISTANT_PTT_TRANSCRIBE_KEYSYM,
      )
      const translateKeysym = Option.getOrElse(
        config.pttTranslateKeysym,
        () => DEFAULT_ASSISTANT_PTT_TRANSLATE_KEYSYM,
      )

      const sourceLanguage = config.sttConfig.translationSourceLanguage
      const targetLanguage = config.sttConfig.translationTargetLanguage

      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          yield* Ref.set(config.pttActiveRef, false)
          const snapshot = yield* coordinator.snapshot
          if (snapshot.mode === "ptt-transcribe" || snapshot.mode === "ptt-translate") {
            yield* coordinator.stop(snapshot.mode)
          }
        }),
      )

      const recognize = (event: {
        readonly released: boolean
        readonly keysym: number
      }): { readonly mode: AssistantPttMode; readonly phase: "press" | "release" } | undefined => {
        if (event.keysym === transcribeKeysym) {
          return { mode: "transcribe", phase: event.released ? "release" : "press" }
        }
        if (event.keysym === translateKeysym) {
          return { mode: "translate", phase: event.released ? "release" : "press" }
        }
        return undefined
      }

      const wrapHandle = (
        baseHandle: PttCaptureHandle,
        mode: AssistantPttMode,
        recordingMode: RecordingMode,
      ): PttCaptureHandle => ({
        offer: (chunk) => baseHandle.offer(chunk),
        finish: (clip) =>
          Effect.gen(function* () {
            yield* coordinator.stop(recordingMode)
            yield* baseHandle.finish(clip)
            config.diagnostics?.pttFinalize(clip.durationMs)
            config.diagnostics?.setState("idle")
          }).pipe(Effect.ensuring(Ref.set(config.pttActiveRef, false))),
        cancel: Effect.gen(function* () {
          yield* baseHandle.cancel.pipe(Effect.ignore)
          const snapshot = yield* coordinator.snapshot
          if (snapshot.mode === "ptt-transcribe" || snapshot.mode === "ptt-translate") {
            yield* coordinator.stop(snapshot.mode)
          }
          yield* Ref.set(config.pttActiveRef, false)
          config.diagnostics?.setState("idle")
        }),
      })

      return yield* runPttLoop({
        recognize,
        recordOptions: {
          sampleSpec: {
            format: 3, // PA_SAMPLE_FORMAT.S16LE
            channels: 1,
            rate: DEFAULT_ASSISTANT_SAMPLE_RATE,
          },
          fragmentSize: DEFAULT_ASSISTANT_PTT_FRAGMENT_SIZE,
          sourceName: config.sourceName,
        },
        minDurationMs: DEFAULT_ASSISTANT_MIN_DURATION_MS,
        logPrefix: (mode) =>
          mode === "transcribe" ? "assistant-ptt-transcribe" : "assistant-ptt-translate",
        onReady: Effect.gen(function* () {
          yield* Console.log(
            `[assistant] PTT transcribe armed on keysym=${transcribeKeysym} source=${config.sourceName}`,
          )
          yield* Console.log(
            `[assistant] PTT translate armed on keysym=${translateKeysym} source=${config.sourceName} (${sourceLanguage} -> ${targetLanguage})`,
          )
          yield* Console.log(
            `PTT transcribe ready (keysym=${transcribeKeysym}). Hold key to dictate.`,
          )
          yield* Console.log(
            `PTT translate ready (keysym=${translateKeysym}, ${sourceLanguage} -> ${targetLanguage}). Hold key to dictate.`,
          )
        }),
        onPress: (mode) =>
          Effect.gen(function* () {
            const recordingMode: RecordingMode =
              mode === "transcribe" ? "ptt-transcribe" : "ptt-translate"

            const result = yield* coordinator.tryStart(recordingMode)

            if (result["_tag"] === "Busy") {
              yield* Console.log(`[assistant-ptt-${mode}] Ignored: ${result.activeMode} is active`)
              return "skip" as const
            }

            if (result["_tag"] === "Disabled") {
              yield* Console.log(`[assistant-ptt-${mode}] Ignored: PIE is disabled`)
              return "skip" as const
            }

            const baseHandle = yield* makeStreamedSttHandle({
              sampleRate: DEFAULT_ASSISTANT_SAMPLE_RATE,
              logPrefix: `assistant-ptt-${mode}`,
              failurePrefix:
                mode === "transcribe" ? "PTT transcription failed" : "PTT translation failed",
              diagnostics: config.diagnostics,
              operation:
                mode === "transcribe"
                  ? {
                      kind: "transcribe",
                      model: config.sttConfig.transcriptionModel,
                      language: config.sttConfig.transcriptionLanguage,
                      promptTemplate: config.sttConfig.transcriptionPrompt,
                    }
                  : {
                      kind: "translate",
                      model: config.sttConfig.translationModel,
                      sourceLanguage,
                      targetLanguage,
                      promptTemplate: config.sttConfig.translationPrompt,
                    },
            })

            yield* Ref.set(config.pttActiveRef, true)
            config.diagnostics?.pttHold(mode)
            config.diagnostics?.setState(recordingMode)

            return wrapHandle(baseHandle, mode, recordingMode)
          }),
        onRelease: (mode) =>
          Effect.sync(() => {
            config.diagnostics?.pttRelease()
          }),
        onAbort: coordinator.snapshot.pipe(Effect.map((s) => !s.enabled)),
      })
    }),
  )
