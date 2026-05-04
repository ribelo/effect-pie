import { Console, Effect, Fiber, Option, Ref, Stream } from "effect"
import { Command } from "effect/unstable/cli"
import { PulseAudioClient } from "../pulse/client.js"
import { PA_SAMPLE_FORMAT } from "../pulse/defs.js"
import { createRecordStream } from "../pulse/stream.js"
import { pcmPeak, pcmRms } from "../audio/pcm.js"
import { optionalSourceFlag, positiveIntegerFlag } from "./shared.js"

export const meterCommand = Command.make(
  "meter",
  {
    duration: positiveIntegerFlag("duration", "Meter duration in seconds", 10),
    sampleRate: positiveIntegerFlag("sample-rate", "Sample rate in Hz", 16_000),
    channels: positiveIntegerFlag("channels", "Number of channels", 1),
    fragmentSize: positiveIntegerFlag("fragment-size", "PulseAudio fragment size in bytes", 1024),
    every: positiveIntegerFlag("every", "Print metrics every N chunks", 1),
    source: optionalSourceFlag,
  },
  (config) =>
    Effect.gen(function* () {
      const client = yield* PulseAudioClient
      yield* client.connect()

      const program = Effect.gen(function* () {
        const maxRmsRef = yield* Ref.make(0)
        const maxPeakRef = yield* Ref.make(0)
        const chunkCountRef = yield* Ref.make(0)

        const recordOptions: {
          sampleSpec: {
            format: PA_SAMPLE_FORMAT
            channels: number
            rate: number
          }
          fragmentSize: number
          sourceName?: string
        } = {
          sampleSpec: {
            format: PA_SAMPLE_FORMAT.S16LE,
            channels: config.channels,
            rate: config.sampleRate,
          },
          fragmentSize: config.fragmentSize,
        }

        if (Option.isSome(config.source)) {
          recordOptions.sourceName = config.source.value
        }

        yield* Console.log(
          `Meter running for ${config.duration}s on source ${Option.isSome(config.source) ? config.source.value : "@DEFAULT_SOURCE@"}`,
        )

        const meterFiber = yield* createRecordStream(recordOptions).pipe(
          Stream.runForEach((chunk) =>
            Effect.gen(function* () {
              const rms = pcmRms(chunk)
              const peak = pcmPeak(chunk)

              yield* Ref.update(maxRmsRef, (value) => (rms > value ? rms : value))
              yield* Ref.update(maxPeakRef, (value) => (peak > value ? peak : value))

              const chunkIndex = yield* Ref.updateAndGet(chunkCountRef, (value) => value + 1)
              if (chunkIndex % config.every === 0) {
                yield* Console.log(
                  `[meter chunk=${chunkIndex}] rms=${rms.toFixed(4)} peak=${peak.toFixed(4)}`,
                )
              }
            }),
          ),
          Effect.forkDetach,
        )

        yield* Effect.sleep(`${config.duration} seconds`)
        yield* Fiber.interrupt(meterFiber)

        const maxRms = yield* Ref.get(maxRmsRef)
        const maxPeak = yield* Ref.get(maxPeakRef)
        const chunks = yield* Ref.get(chunkCountRef)

        yield* Console.log(
          `Meter complete. chunks=${chunks} max_rms=${maxRms.toFixed(4)} max_peak=${maxPeak.toFixed(4)}`,
        )
      })

      yield* program.pipe(Effect.ensuring(client.disconnect))
    }),
).pipe(
  Command.withDescription("Print live input RMS/peak to verify microphone level and threshold"),
)
