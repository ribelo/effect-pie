import { Console, Effect, Fiber, Option, Ref, Stream } from "effect"
import { Command, Flag } from "effect/unstable/cli"
import { loadSttRuntimeConfig, type SttConfigError } from "../stt/config.js"
import { OpenRouterSttError, transcribePcmWithOpenRouter } from "../stt/openrouter.js"
import { createRecordStream } from "../pulse/stream.js"
import { makePcmRecordOptions } from "../pulse/defs.js"
import { typeTextWithWtype, type WtypeError } from "../wayland/wtype.js"
import {
  CliError,
  concatChunks,
  drainPendingStdin,
  optionalSourceFlag,
  positiveIntegerFlag,
  waitForEnter,
} from "./shared.js"

export const sttInteractiveCommand = Command.make(
  "stt-interactive",
  {
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
    noType: Flag.boolean("no-type").pipe(
      Flag.withDescription("Disable typing streamed deltas via wtype"),
    ),
  },
  (config) =>
    Effect.gen(function* () {
      const sttConfig = yield* loadSttRuntimeConfig().pipe(
        Effect.mapError(
          (cause: SttConfigError) =>
            new CliError({
              message: `Failed to load STT config: ${cause.message}`,
              cause,
            }),
        ),
      )

      const transcriptionModel = sttConfig.openrouter.transcriptionModel
      const transcriptionLanguage = sttConfig.openrouter.transcriptionLanguage

      yield* Console.log(
        `[stt-interactive] Ready. Model=${transcriptionModel}, language=${transcriptionLanguage}. Press Enter to start, Enter to stop, Ctrl+C to exit.`,
      )

      if (!config.noType) {
        yield* Console.log(
          "[stt-interactive] Streaming deltas will be typed with wtype into the currently focused Wayland window.",
        )
      }

      while (true) {
        yield* drainPendingStdin

        yield* waitForEnter("[stt-interactive] Press Enter to start listening")

        const chunksRef = yield* Ref.make<ReadonlyArray<Uint8Array>>([])

        const recordOptions = makePcmRecordOptions({
          rate: config.sampleRate,
          fragmentSize: config.fragmentSize,
          sourceName: Option.getOrUndefined(config.source),
        })

        const recordFiber = yield* createRecordStream(recordOptions).pipe(
          Stream.runForEach((chunk) => Ref.update(chunksRef, (chunks) => [...chunks, chunk])),
          Effect.forkDetach,
        )

        yield* waitForEnter("[stt-interactive] Listening... Press Enter to stop")

        yield* Fiber.interrupt(recordFiber)

        const chunks = yield* Ref.get(chunksRef)
        const pcmBytes = concatChunks(chunks)

        if (pcmBytes.length === 0) {
          yield* Console.log("[stt-interactive] Ignored empty capture")
          continue
        }

        const durationMs = Math.round((pcmBytes.length / 2 / config.sampleRate) * 1000)
        if (durationMs < config.minDurationMs) {
          yield* Console.log(
            `[stt-interactive] Ignored short capture (${durationMs}ms < ${config.minDurationMs}ms)`,
          )
          continue
        }

        const transcript = yield* transcribePcmWithOpenRouter({
          model: transcriptionModel,
          pcmBytes,
          sampleRate: config.sampleRate,
          language: transcriptionLanguage,
          promptTemplate: sttConfig.transcriptionPrompt,
          ...(config.noType
            ? {}
            : {
                onDelta: (delta: string) =>
                  typeTextWithWtype(delta).pipe(
                    Effect.mapError(
                      (cause: WtypeError) =>
                        new OpenRouterSttError({
                          message: `Failed typing streamed delta with wtype: ${cause.message}`,
                          cause,
                        }),
                    ),
                  ),
              }),
        }).pipe(
          Effect.mapError(
            (cause: OpenRouterSttError) =>
              new CliError({
                message: `Streaming STT failed: ${cause.message}`,
                cause,
              }),
          ),
        )

        yield* Console.log("")
        yield* Console.log(`[stt-interactive] Transcript: ${transcript}`)
      }
    }),
).pipe(
  Command.withDescription(
    "Interactive STT test loop (Enter start/stop, OpenRouter streaming, optional wtype delta typing)",
  ),
)
