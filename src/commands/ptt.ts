import { Console, Duration, Effect, Option, Queue, Ref, Stream } from "effect"
import { Command, Flag } from "effect/unstable/cli"
import * as path from "node:path"
import { KeyboardMonitorService, PttKeyboardError } from "../keyboard/monitor.js"
import type { PulseAudioClient } from "../pulse/client.js"
import { makePcmRecordOptions } from "../pulse/defs.js"
import { createRecordStream } from "../pulse/stream.js"
import { MIN_GAIN_TO_APPLY, normalizePcmForStt, pcmPeak, pcmRms } from "../audio/pcm.js"
import { loadSttRuntimeConfig, STT_CONFIG_PATH, type SttConfigError } from "../stt/config.js"
import { OpenRouterSttService, type OpenRouterSttError } from "../stt/openrouter.js"
import { injectTranscript, type TextInjectionBackendService } from "../input/textInjection.js"
import type { DesktopSession } from "../desktop/session.js"
import { notifyWarning } from "../desktop/notification.js"
import {
  pttCaptureIdle,
  pttCaptureIsAcceptingChunks,
  pttCapturePostRollRemainingMs,
  pttCaptureRelease,
  pttCaptureStart,
  type PttCaptureState,
} from "../ptt/capture.js"
import {
  pttDeadInputDetectorInitial,
  pttDeadInputDetectorProcessChunk,
  pttDeadInputDetectorSync,
} from "../ptt/deadInput.js"
import {
  closeGlobalShortcutSession,
  monitorPortalSignals,
  setupGlobalShortcutSession,
} from "../wayland/globalShortcuts.js"
import { writePcmWavFile, type WakewordTrainingError } from "../wakeword/training.js"
import { EFFECT_PI_DATA_DIR } from "../paths.js"
import {
  concatChunks,
  makePttClipPath,
  optionalPositiveIntegerFlag,
  optionalSourceFlag,
  positiveIntegerFlag,
} from "./shared.js"

type PttTriggerBinding = {
  readonly keycode: number
  readonly keysym: number
}

type PttCapturedClip = {
  readonly durationMs: number
  readonly pcmBytes: Uint8Array
}

type KeyboardMonitorPttConfig = {
  readonly keycode: Option.Option<number>
  readonly keysym: Option.Option<number>
  readonly source: Option.Option<string>
  readonly minDurationMs: number
  readonly sampleRate: number
  readonly fragmentSize: number
  readonly logPrefix: string
  readonly armedMessage: (trigger: PttTriggerBinding) => string
  readonly onClip: (
    clip: PttCapturedClip,
  ) => Effect.Effect<
    void,
    PttKeyboardError,
    DesktopSession | TextInjectionBackendService | OpenRouterSttService
  >
}

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

export const runKeyboardMonitorPtt = Effect.fn("pie/commands/ptt.runKeyboardMonitorPtt")(function* (
  config: KeyboardMonitorPttConfig,
): Effect.fn.Return<
  never,
  PttKeyboardError,
  | PulseAudioClient
  | KeyboardMonitorService
  | DesktopSession
  | TextInjectionBackendService
  | OpenRouterSttService
> {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const keyboard = yield* KeyboardMonitorService
      const eventQueue = yield* keyboard.subscribe

      const triggerRef = yield* Ref.make<PttTriggerBinding | undefined>(
        Option.isSome(config.keycode)
          ? {
              keycode: config.keycode.value,
              keysym: Option.isSome(config.keysym) ? config.keysym.value : 0,
            }
          : Option.isSome(config.keysym)
            ? {
                keycode: 0,
                keysym: config.keysym.value,
              }
            : undefined,
      )

      if (Option.isNone(config.keycode) && Option.isNone(config.keysym)) {
        yield* Console.log(
          "PTT key not configured. Press the key you want to use for push-to-talk to learn it now.",
        )

        while (true) {
          const event = yield* Queue.take(eventQueue)
          if (event.released) {
            continue
          }

          yield* Ref.set(triggerRef, {
            keycode: event.keycode,
            keysym: event.keysym,
          })

          yield* Console.log(
            `Learned trigger key: keycode=${event.keycode} keysym=${event.keysym} (use --keycode ${event.keycode} for a stable binding)`,
          )
          break
        }
      }

      const trigger = yield* Ref.get(triggerRef)
      if (trigger === undefined) {
        return yield* new PttKeyboardError({
          message: "No push-to-talk key configured. Use --keycode/--keysym or learn one.",
        })
      }

      const captureStateRef = yield* Ref.make<PttCaptureState>(pttCaptureIdle)
      const captureChunksRef = yield* Ref.make<ReadonlyArray<Uint8Array>>([])
      const captureStartedAtRef = yield* Ref.make<number | undefined>(undefined)

      const recordOptions = makePcmRecordOptions({
        rate: config.sampleRate,
        fragmentSize: config.fragmentSize,
        sourceName: Option.getOrUndefined(config.source),
      })

      const deadInputDetectorRef = yield* Ref.make(pttDeadInputDetectorInitial())

      yield* createRecordStream(recordOptions).pipe(
        Stream.runForEach((chunk) =>
          Effect.gen(function* () {
            const state = yield* Ref.get(captureStateRef)
            const isActive = pttCaptureIsAcceptingChunks(state)

            yield* Ref.update(deadInputDetectorRef, (detector) =>
              pttDeadInputDetectorSync(detector, isActive),
            )

            if (!isActive) {
              return
            }

            yield* Ref.update(captureChunksRef, (chunks) => {
              const next = chunks.slice()
              next.push(chunk)
              return next
            })

            const { detector: nextDetector, warn } = pttDeadInputDetectorProcessChunk(
              yield* Ref.get(deadInputDetectorRef),
              chunk,
            )
            yield* Ref.set(deadInputDetectorRef, nextDetector)

            if (warn) {
              yield* Console.log(
                `[${config.logPrefix}] No input detected; microphone probably muted`,
              )
              yield* notifyWarning(
                "pie: no microphone input",
                "No input detected during push-to-talk. Your microphone may be muted.",
              )
            }
          }),
        ),
        Effect.forkScoped,
      )

      yield* Console.log(config.armedMessage(trigger))

      mainLoop: while (true) {
        const event = yield* Queue.take(eventQueue)

        const keycodeMatches = trigger.keycode > 0 && event.keycode === trigger.keycode
        const keysymMatches = trigger.keysym > 0 && event.keysym === trigger.keysym

        if (!keycodeMatches && !keysymMatches) {
          continue
        }

        if (!event.released) {
          const state = yield* Ref.get(captureStateRef)
          const nextState = pttCaptureStart(state, Date.now())
          if (nextState === state) {
            continue
          }

          if (state.tag === "postRoll") {
            yield* Ref.set(captureStateRef, nextState)
            yield* Console.log(`[${config.logPrefix}] Post-roll cancelled, continuing capture`)
            continue
          }

          yield* Ref.set(captureChunksRef, [])
          yield* Ref.set(captureStartedAtRef, Date.now())
          yield* Ref.set(captureStateRef, nextState)
          yield* Console.log(`[${config.logPrefix}] Capturing... release key to stop`)
          continue
        }

        const state = yield* Ref.get(captureStateRef)
        if (state.tag !== "capturing") {
          continue
        }

        yield* Ref.set(captureStateRef, pttCaptureRelease(state, Date.now()))

        postRollLoop: while (true) {
          const postRollState = yield* Ref.get(captureStateRef)
          const remaining = pttCapturePostRollRemainingMs(postRollState, Date.now())
          if (remaining <= 0) {
            break postRollLoop
          }

          const nextEvent = yield* Queue.take(eventQueue).pipe(
            Effect.timeoutOrElse({
              duration: Duration.millis(remaining),
              orElse: () => Effect.succeed(undefined),
            }),
          )

          if (nextEvent === undefined) {
            break postRollLoop
          }

          const evt = nextEvent
          const nextKeycodeMatches = trigger.keycode > 0 && evt.keycode === trigger.keycode
          const nextKeysymMatches = trigger.keysym > 0 && evt.keysym === trigger.keysym

          if (!nextKeycodeMatches && !nextKeysymMatches) {
            continue postRollLoop
          }

          if (!evt.released) {
            yield* Ref.update(captureStateRef, (s) => pttCaptureStart(s, Date.now()))
            yield* Console.log(`[${config.logPrefix}] Post-roll cancelled, continuing capture`)
            continue mainLoop
          }
        }

        yield* Ref.set(captureStateRef, pttCaptureIdle)

        const startedAt = yield* Ref.get(captureStartedAtRef)
        yield* Ref.set(captureStartedAtRef, undefined)

        const durationMs = startedAt === undefined ? 0 : Date.now() - startedAt
        const chunks = yield* Ref.get(captureChunksRef)
        yield* Ref.set(captureChunksRef, [])

        const capturedBytes = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
        yield* Console.log(
          `[${config.logPrefix}] Capture stopped (${durationMs}ms, ${capturedBytes} bytes)`,
        )

        if (durationMs < config.minDurationMs) {
          yield* Console.log(
            `[${config.logPrefix}] Ignored short clip (${durationMs}ms < ${config.minDurationMs}ms)`,
          )
          continue
        }

        const rawPcmBytes = concatChunks(chunks)
        if (rawPcmBytes.length === 0) {
          yield* Console.log(`[${config.logPrefix}] Ignored empty clip`)
          continue
        }

        const { normalizedBytes, gain } = normalizePcmForStt(rawPcmBytes)
        if (gain > MIN_GAIN_TO_APPLY) {
          yield* Console.log(
            `[${config.logPrefix}] Normalized clip (rms=${pcmRms(rawPcmBytes).toFixed(4)} peak=${pcmPeak(rawPcmBytes).toFixed(4)} gain=${gain.toFixed(2)})`,
          )
        }

        yield* config.onClip({
          durationMs,
          pcmBytes: normalizedBytes,
        })
      }
    }),
  )
})

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
    runKeyboardMonitorPtt({
      keycode: config.keycode,
      keysym: config.keysym,
      source: config.source,
      minDurationMs: config.minDurationMs,
      sampleRate: config.sampleRate,
      fragmentSize: config.fragmentSize,
      logPrefix: "ptt",
      armedMessage: (trigger) =>
        `PTT armed. Hold keycode=${trigger.keycode} keysym=${trigger.keysym} to record. Clips -> ${config.outputDir}. Press Ctrl+C to stop.`,
      onClip: (clip) =>
        Effect.gen(function* () {
          const outputPath = makePttClipPath(config.outputDir)
          yield* writePcmWavFile(outputPath, clip.pcmBytes, config.sampleRate).pipe(
            Effect.mapError((cause: WakewordTrainingError) =>
              toPttKeyboardError(
                `Failed to write PTT clip at ${outputPath}: ${cause.message}`,
                cause,
              ),
            ),
          )

          const seconds = (clip.durationMs / 1000).toFixed(2)
          yield* Console.log(`[ptt] Saved ${outputPath} (${seconds}s)`)
        }),
    }),
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

      const transcriptionModel = sttConfig.openrouter.transcriptionModel
      const transcriptionLanguage = sttConfig.openrouter.transcriptionLanguage

      yield* Console.log(
        `[ptt-transcribe] Model: ${transcriptionModel} (config: ${STT_CONFIG_PATH})`,
      )
      yield* Console.log(`[ptt-transcribe] Language: ${transcriptionLanguage}`)

      return yield* runKeyboardMonitorPtt({
        keycode: config.keycode,
        keysym: config.keysym,
        source: config.source,
        minDurationMs: config.minDurationMs,
        sampleRate: config.sampleRate,
        fragmentSize: config.fragmentSize,
        logPrefix: "ptt-transcribe",
        armedMessage: (trigger) =>
          `PTT transcribe armed. Hold keycode=${trigger.keycode} keysym=${trigger.keysym} to dictate. Press Ctrl+C to stop.`,
        onClip: (clip) =>
          Effect.gen(function* () {
            const stt = yield* Effect.service(OpenRouterSttService)
            const transcript = yield* stt
              .transcribe({
                model: transcriptionModel,
                pcmBytes: clip.pcmBytes,
                sampleRate: config.sampleRate,
                language: transcriptionLanguage,
                promptTemplate: sttConfig.transcriptionPrompt,
              })
              .pipe(
                Effect.mapError((cause: OpenRouterSttError) =>
                  toPttKeyboardError(`STT request failed: ${cause.message}`, cause),
                ),
              )

            yield* injectTranscript({
              text: transcript,
              logPrefix: "ptt-transcribe",
              inject: config.inject,
            }).pipe(
              Effect.mapError((cause) =>
                toPttKeyboardError(`Failed to inject transcript text: ${cause.message}`, cause),
              ),
            )
          }),
      })
    }),
).pipe(
  Command.withDescription(
    "Push-to-talk transcription via OpenRouter (model configured in $XDG_CONFIG_HOME/pie/stt.json)",
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

      const translationModel = sttConfig.openrouter.translationModel
      const sourceLanguage = sttConfig.openrouter.translationSourceLanguage
      const targetLanguage = Option.isSome(config.targetLanguage)
        ? config.targetLanguage.value
        : sttConfig.openrouter.translationTargetLanguage

      yield* Console.log(`[ptt-translate] Model: ${translationModel} (config: ${STT_CONFIG_PATH})`)
      yield* Console.log(`[ptt-translate] Source language: ${sourceLanguage}`)
      yield* Console.log(`[ptt-translate] Target language: ${targetLanguage}`)

      return yield* runKeyboardMonitorPtt({
        keycode: config.keycode,
        keysym: config.keysym,
        source: config.source,
        minDurationMs: config.minDurationMs,
        sampleRate: config.sampleRate,
        fragmentSize: config.fragmentSize,
        logPrefix: "ptt-translate",
        armedMessage: (trigger) =>
          `PTT translate armed. Hold keycode=${trigger.keycode} keysym=${trigger.keysym} to dictate. ${sourceLanguage} -> ${targetLanguage}. Press Ctrl+C to stop.`,
        onClip: (clip) =>
          Effect.gen(function* () {
            const stt = yield* Effect.service(OpenRouterSttService)
            const translated = yield* stt
              .translate({
                model: translationModel,
                pcmBytes: clip.pcmBytes,
                sampleRate: config.sampleRate,
                sourceLanguage,
                targetLanguage,
                promptTemplate: sttConfig.translationPrompt,
              })
              .pipe(
                Effect.mapError((cause: OpenRouterSttError) =>
                  toPttKeyboardError(`STT+translation request failed: ${cause.message}`, cause),
                ),
              )

            yield* injectTranscript({
              text: translated,
              logPrefix: "ptt-translate",
              inject: config.inject,
            }).pipe(
              Effect.mapError((cause) =>
                toPttKeyboardError(`Failed to inject translated text: ${cause.message}`, cause),
              ),
            )
          }),
      })
    }),
).pipe(
  Command.withDescription(
    "Push-to-talk transcription + translation via OpenRouter (model configured in $XDG_CONFIG_HOME/pie/stt.json)",
  ),
)
