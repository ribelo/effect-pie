import { Console, Effect, Fiber, Option, Queue, Ref, Stream, type Cause } from "effect"
import { Command, Flag } from "effect/unstable/cli"
import { loadSttRuntimeConfig, type SttConfigError } from "../stt/config.js"
import { SttService, type SttServiceError } from "../stt/service.js"
import { createRecordStream } from "../pulse/stream.js"
import { makePcmRecordOptions } from "../pulse/defs.js"
import { typeTextWithWtype, type WtypeError } from "../wayland/wtype.js"
import {
  CliError,
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

      const transcriptionModel = sttConfig.transcriptionModel
      const transcriptionLanguage = sttConfig.transcriptionLanguage

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

        const recordOptions = makePcmRecordOptions({
          rate: config.sampleRate,
          fragmentSize: config.fragmentSize,
          sourceName: Option.getOrUndefined(config.source),
        })

        const transcript = yield* Effect.scoped(
          Effect.gen(function* () {
            const audioQueue = yield* Queue.unbounded<Uint8Array, Cause.Done>()
            const capturedBytesRef = yield* Ref.make(0)

            const transcriptFiber = yield* Effect.gen(function* () {
              const stt = yield* SttService
              return yield* stt.transcribeStream({
                model: transcriptionModel,
                audio: Stream.fromQueue(audioQueue),
                sampleRate: config.sampleRate,
                language: transcriptionLanguage,
                promptTemplate: sttConfig.transcriptionPrompt,
                ...(config.noType
                  ? {}
                  : {
                      onDelta: (delta: string) =>
                        typeTextWithWtype(delta).pipe(
                          Effect.tapError((cause: WtypeError) =>
                            Console.log(
                              `[stt-interactive] wtype typing error for delta: ${cause.message}`,
                            ),
                          ),
                          Effect.ignore,
                        ),
                    }),
              })
            }).pipe(
              Effect.provide(SttService.live(sttConfig)),
              Effect.mapError(
                (cause: SttServiceError) =>
                  new CliError({
                    message: `Streaming STT failed: ${cause.message}`,
                    cause,
                  }),
              ),
              Effect.forkScoped,
            )

            yield* createRecordStream(recordOptions).pipe(
              Stream.runForEach((chunk) =>
                Effect.all(
                  [
                    Ref.update(capturedBytesRef, (current) => current + chunk.length),
                    Queue.offer(audioQueue, chunk),
                  ],
                  { discard: true },
                ),
              ),
              Effect.forkScoped,
            )

            yield* waitForEnter("[stt-interactive] Listening... Press Enter to stop")
            yield* Queue.end(audioQueue)

            const capturedBytes = yield* Ref.get(capturedBytesRef)
            if (capturedBytes === 0) {
              yield* Fiber.interrupt(transcriptFiber)
              yield* Console.log("[stt-interactive] Ignored empty capture")
              return undefined
            }

            const durationMs = Math.round((capturedBytes / 2 / config.sampleRate) * 1000)
            if (durationMs < config.minDurationMs) {
              yield* Fiber.interrupt(transcriptFiber)
              yield* Console.log(
                `[stt-interactive] Ignored short capture (${durationMs}ms < ${config.minDurationMs}ms)`,
              )
              return undefined
            }

            return yield* Fiber.join(transcriptFiber)
          }),
        )

        if (transcript === undefined) {
          continue
        }

        yield* Console.log("")
        yield* Console.log(`[stt-interactive] Transcript: ${transcript}`)
      }
    }),
).pipe(
  Command.withDescription(
    "Interactive STT test loop (Enter start/stop, configured STT provider, optional wtype delta typing)",
  ),
)
