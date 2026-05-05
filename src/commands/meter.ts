import { Console, Effect, Option, Ref, Stream } from "effect"
import { Command } from "effect/unstable/cli"
import { makePcmRecordOptions } from "../pulse/defs.js"
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
      const program = Effect.gen(function* () {
        const maxRmsRef = yield* Ref.make(0)
        const maxPeakRef = yield* Ref.make(0)
        const chunkCountRef = yield* Ref.make(0)

        const recordOptions = makePcmRecordOptions({
          channels: config.channels,
          rate: config.sampleRate,
          fragmentSize: config.fragmentSize,
          sourceName: Option.getOrUndefined(config.source),
        })

        yield* Console.log(
          `Meter running for ${config.duration}s on source ${Option.isSome(config.source) ? config.source.value : "@DEFAULT_SOURCE@"}`,
        )

        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* createRecordStream(recordOptions).pipe(
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
              Effect.forkScoped,
            )

            yield* Effect.sleep(`${config.duration} seconds`)
          }),
        )

        const maxRms = yield* Ref.get(maxRmsRef)
        const maxPeak = yield* Ref.get(maxPeakRef)
        const chunks = yield* Ref.get(chunkCountRef)

        yield* Console.log(
          `Meter complete. chunks=${chunks} max_rms=${maxRms.toFixed(4)} max_peak=${maxPeak.toFixed(4)}`,
        )
      })

      yield* program
    }),
).pipe(
  Command.withDescription("Print live input RMS/peak to verify microphone level and threshold"),
)
