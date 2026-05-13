import { Console, Effect, Layer, Option, Queue } from "effect"
import { Command, Flag } from "effect/unstable/cli"
import * as path from "node:path"
import { KeyboardMonitorService, PttKeyboardError } from "../keyboard/monitor.js"
import { makePcmRecordOptions } from "../pulse/defs.js"

import { loadSttRuntimeConfig, STT_CONFIG_PATH, type SttConfigError } from "../stt/config.js"
import { SttService } from "../stt/service.js"
import { Niri } from "../niri/niri.js"

import {
  closeGlobalShortcutSession,
  monitorPortalSignals,
  setupGlobalShortcutSession,
} from "../wayland/globalShortcuts.js"

import { EFFECT_PI_DATA_DIR } from "../paths.js"
import { optionalPositiveIntegerFlag, optionalSourceFlag, positiveIntegerFlag } from "./shared.js"
import { runPttLoop } from "../ptt/loop.js"
import { makeStreamedSttHandle, makeWavClipHandle } from "../ptt/handles.js"

const pttKeycodeFlag = optionalPositiveIntegerFlag(
  "keycode",
  "Hardware keycode to use as push-to-talk trigger (learned if omitted)",
)

const pttKeysymFlag = optionalPositiveIntegerFlag(
  "keysym",
  "XKB keysym to use as trigger (alternative to --keycode)",
)

export const toPttKeyboardError = (message: string, cause: unknown): PttKeyboardError =>
  new PttKeyboardError({
    message,
    cause,
  })

type TriggerBinding = {
  readonly keycode: number
  readonly keysym: number
}

const resolveTriggerBinding = (config: {
  readonly keycode: Option.Option<number>
  readonly keysym: Option.Option<number>
}): Effect.Effect<TriggerBinding, PttKeyboardError, KeyboardMonitorService> =>
  Effect.scoped(
    Effect.gen(function* () {
      if (Option.isSome(config.keycode) || Option.isSome(config.keysym)) {
        return {
          keycode: Option.getOrElse(config.keycode, () => 0),
          keysym: Option.getOrElse(config.keysym, () => 0),
        }
      }

      yield* Console.log(
        "PTT key not configured. Press the key you want to use for push-to-talk to learn it now.",
      )

      const keyboard = yield* KeyboardMonitorService
      const eventQueue = yield* keyboard.subscribe

      while (true) {
        const event = yield* Queue.take(eventQueue)
        if (event.released) {
          continue
        }

        yield* Console.log(
          `Learned trigger key: keycode=${event.keycode} keysym=${event.keysym} (use --keycode ${event.keycode} for a stable binding)`,
        )

        return { keycode: event.keycode, keysym: event.keysym }
      }
    }),
  )

const makePttRecognize =
  (binding: TriggerBinding) =>
  (event: { readonly released: boolean; readonly keycode: number; readonly keysym: number }) => {
    const keycodeMatches = binding.keycode > 0 && event.keycode === binding.keycode
    const keysymMatches = binding.keysym > 0 && event.keysym === binding.keysym
    if (!keycodeMatches && !keysymMatches) {
      return undefined
    }
    return {
      mode: "ptt" as const,
      phase: event.released ? ("release" as const) : ("press" as const),
    }
  }

export const pttPortalCommand = Command.make(
  "ptt-portal",
  {
    shortcut: Flag.string("shortcut").pipe(
      Flag.withDescription("Shortcut accelerator in portal syntax"),
      Flag.withDefault("<Ctrl><Super>space"),
    ),
    id: Flag.string("id").pipe(
      Flag.withDescription("Portal shortcut id"),
      Flag.withDefault("push_to_talk"),
    ),
    description: Flag.string("description").pipe(
      Flag.withDescription("Shortcut description shown by desktop portal"),
      Flag.withDefault("pie push-to-talk"),
    ),
    parentWindow: Flag.string("parent-window").pipe(
      Flag.withDescription("Parent window id (leave empty for headless CLI)"),
      Flag.withDefault(""),
    ),
  },
  (config) =>
    Effect.gen(function* () {
      const session = yield* setupGlobalShortcutSession({
        parentWindow: config.parentWindow,
        shortcut: {
          id: config.id,
          description: config.description,
          preferredTrigger: config.shortcut,
        },
      })

      yield* Console.log(`PTT shortcut id: ${session.shortcut.id}`)
      yield* Console.log(`Preferred trigger: ${session.shortcut.preferredTrigger}`)
      yield* Console.log(`CreateSession request handle: ${session.createRequestHandle}`)
      yield* Console.log(`BindShortcuts request handle: ${session.bindRequestHandle}`)
      yield* Console.log(`Session handle: ${session.sessionHandle}`)
      yield* Console.log(
        'Portal monitor started. Look for Member="Activated" and Member="Deactivated". Press Ctrl+C to stop.',
      )

      return yield* monitorPortalSignals().pipe(
        Effect.ensuring(closeGlobalShortcutSession(session).pipe(Effect.ignore)),
      )
    }),
).pipe(Command.withDescription("Spike command for xdg-desktop-portal GlobalShortcuts capture"))

export const pttCommand = Command.make(
  "ptt",
  {
    keycode: pttKeycodeFlag,
    keysym: pttKeysymFlag,
    source: optionalSourceFlag,
    outputDir: Flag.string("output-dir").pipe(
      Flag.withDescription("Directory where captured PTT WAV clips will be saved"),
      Flag.withDefault(path.join(EFFECT_PI_DATA_DIR, "ptt-clips")),
    ),
    minDurationMs: positiveIntegerFlag(
      "min-duration-ms",
      "Ignore clips shorter than this many milliseconds",
      120,
    ),
    sampleRate: positiveIntegerFlag("sample-rate", "PCM sample rate for capture", 16_000),
    fragmentSize: positiveIntegerFlag(
      "fragment-size",
      "PulseAudio record fragment size in bytes",
      4096,
    ),
  },
  (config) =>
    Effect.scoped(
      Effect.gen(function* () {
        const binding = yield* resolveTriggerBinding({
          keycode: config.keycode,
          keysym: config.keysym,
        })

        yield* Effect.sleep("50 millis")

        return yield* runPttLoop({
          recognize: makePttRecognize(binding),
          recordOptions: makePcmRecordOptions({
            rate: config.sampleRate,
            fragmentSize: config.fragmentSize,
            sourceName: Option.getOrUndefined(config.source),
          }),
          minDurationMs: config.minDurationMs,
          logPrefix: () => "ptt",
          onReady: Console.log(
            `PTT armed. Hold keycode=${binding.keycode} keysym=${binding.keysym} to record. Clips -> ${config.outputDir}. Press Ctrl+C to stop.`,
          ),
          onPress: () =>
            makeWavClipHandle({
              outputDir: config.outputDir,
              sampleRate: config.sampleRate,
              logPrefix: "ptt",
            }),
        })
      }),
    ),
).pipe(
  Command.withDescription(
    "Experimental keyboard-monitor push-to-talk: hold key to capture audio and save clips as WAV",
  ),
)

export const pttTranscribeCommand = Command.make(
  "ptt-transcribe",
  {
    keycode: pttKeycodeFlag,
    keysym: pttKeysymFlag,
    source: optionalSourceFlag,
    minDurationMs: positiveIntegerFlag(
      "min-duration-ms",
      "Ignore clips shorter than this many milliseconds",
      120,
    ),
    sampleRate: positiveIntegerFlag("sample-rate", "PCM sample rate for capture", 16_000),
    fragmentSize: positiveIntegerFlag(
      "fragment-size",
      "PulseAudio record fragment size in bytes",
      4096,
    ),
    inject: Flag.boolean("inject").pipe(
      Flag.withDescription("Type transcript into focused app using wtype/xdotool"),
    ),
  },
  (config) =>
    Effect.gen(function* () {
      const sttConfig = yield* loadSttRuntimeConfig().pipe(
        Effect.mapError((cause: SttConfigError) =>
          toPttKeyboardError(`Failed to load STT config: ${cause.message}`, cause),
        ),
      )

      const transcriptionModel = sttConfig.transcriptionModel
      const transcriptionLanguage = sttConfig.transcriptionLanguage

      yield* Console.log(
        `[ptt-transcribe] Model: ${transcriptionModel} (config: ${STT_CONFIG_PATH})`,
      )
      yield* Console.log(`[ptt-transcribe] Language: ${transcriptionLanguage}`)

      const binding = yield* resolveTriggerBinding({
        keycode: config.keycode,
        keysym: config.keysym,
      })

      yield* Effect.sleep("50 millis")

      return yield* runPttLoop({
        recognize: makePttRecognize(binding),
        recordOptions: makePcmRecordOptions({
          rate: config.sampleRate,
          fragmentSize: config.fragmentSize,
          sourceName: Option.getOrUndefined(config.source),
        }),
        minDurationMs: config.minDurationMs,
        logPrefix: () => "ptt-transcribe",
        onReady: Console.log(
          `PTT transcribe armed. Hold keycode=${binding.keycode} keysym=${binding.keysym} to dictate. Press Ctrl+C to stop.`,
        ),
        onPress: () =>
          makeStreamedSttHandle({
            sampleRate: config.sampleRate,
            logPrefix: "ptt-transcribe",
            failurePrefix: "STT request failed",
            inject: config.inject,
            operation: {
              kind: "transcribe",
              model: transcriptionModel,
              language: transcriptionLanguage,
              promptTemplate: sttConfig.transcriptionPrompt,
            },
          }),
      }).pipe(Effect.provide(Layer.mergeAll(SttService.live(sttConfig), Niri.live())))
    }),
).pipe(
  Command.withDescription(
    "Push-to-talk transcription via the configured STT provider (default: Codex realtime)",
  ),
)

export const pttTranslateCommand = Command.make(
  "ptt-translate",
  {
    keycode: pttKeycodeFlag,
    keysym: pttKeysymFlag,
    source: optionalSourceFlag,
    minDurationMs: positiveIntegerFlag(
      "min-duration-ms",
      "Ignore clips shorter than this many milliseconds",
      120,
    ),
    sampleRate: positiveIntegerFlag("sample-rate", "PCM sample rate for capture", 16_000),
    fragmentSize: positiveIntegerFlag(
      "fragment-size",
      "PulseAudio record fragment size in bytes",
      4096,
    ),
    targetLanguage: Flag.string("target-language").pipe(
      Flag.optional,
      Flag.withDescription("Target language for translated output (defaults from STT config)"),
    ),
    inject: Flag.boolean("inject").pipe(
      Flag.withDescription("Type translated text into focused app using wtype/xdotool"),
    ),
  },
  (config) =>
    Effect.gen(function* () {
      const sttConfig = yield* loadSttRuntimeConfig().pipe(
        Effect.mapError((cause: SttConfigError) =>
          toPttKeyboardError(`Failed to load STT config: ${cause.message}`, cause),
        ),
      )

      const translationModel = sttConfig.translationModel
      const sourceLanguage = sttConfig.translationSourceLanguage
      const targetLanguage = Option.isSome(config.targetLanguage)
        ? config.targetLanguage.value
        : sttConfig.translationTargetLanguage

      yield* Console.log(`[ptt-translate] Model: ${translationModel} (config: ${STT_CONFIG_PATH})`)
      yield* Console.log(`[ptt-translate] Source language: ${sourceLanguage}`)
      yield* Console.log(`[ptt-translate] Target language: ${targetLanguage}`)

      const binding = yield* resolveTriggerBinding({
        keycode: config.keycode,
        keysym: config.keysym,
      })

      yield* Effect.sleep("50 millis")

      return yield* runPttLoop({
        recognize: makePttRecognize(binding),
        recordOptions: makePcmRecordOptions({
          rate: config.sampleRate,
          fragmentSize: config.fragmentSize,
          sourceName: Option.getOrUndefined(config.source),
        }),
        minDurationMs: config.minDurationMs,
        logPrefix: () => "ptt-translate",
        onReady: Console.log(
          `PTT translate armed. Hold keycode=${binding.keycode} keysym=${binding.keysym} to dictate. ${sourceLanguage} -> ${targetLanguage}. Press Ctrl+C to stop.`,
        ),
        onPress: () =>
          makeStreamedSttHandle({
            sampleRate: config.sampleRate,
            logPrefix: "ptt-translate",
            failurePrefix: "STT+translation request failed",
            inject: config.inject,
            operation: {
              kind: "translate",
              model: translationModel,
              sourceLanguage,
              targetLanguage,
              promptTemplate: sttConfig.translationPrompt,
            },
          }),
      }).pipe(Effect.provide(Layer.mergeAll(SttService.live(sttConfig), Niri.live())))
    }),
).pipe(
  Command.withDescription(
    "Push-to-talk transcription + translation via the configured STT provider (default: Codex realtime)",
  ),
)
