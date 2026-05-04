import { Console, Effect, Fiber, Option, Ref, Stream } from "effect"
import { Command, Flag } from "effect/unstable/cli"
import { mkdir as mkdirNode, writeFile as writeNodeFile } from "node:fs/promises"
import * as path from "node:path"
import { PulseAudioClient } from "../pulse/client.js"
import { makePcmRecordOptions } from "../pulse/defs.js"
import { createRecordStream } from "../pulse/stream.js"
import { MIN_GAIN_TO_APPLY, normalizePcmForStt, pcmPeak, pcmRms } from "../audio/pcm.js"
import { CliError, concatChunks, optionalSourceFlag, positiveIntegerFlag } from "./shared.js"

export const recordCommand = Command.make(
  "record",
  {
    duration: positiveIntegerFlag("duration", "Recording duration in seconds", 3),
    output: Flag.string("output").pipe(
      Flag.optional,
      Flag.withDescription("Write raw PCM to this file"),
    ),
    raw: Flag.boolean("raw").pipe(
      Flag.withDescription("Write unnormalized PCM without auto-gain"),
      Flag.withDefault(false),
    ),
    sampleRate: positiveIntegerFlag("sample-rate", "Sample rate in Hz", 16_000),
    channels: positiveIntegerFlag("channels", "Number of channels", 1),
    fragmentSize: positiveIntegerFlag("fragment-size", "PulseAudio fragment size in bytes", 1024),
    source: optionalSourceFlag,
  },
  (config) =>
    Effect.gen(function* () {
      const client = yield* PulseAudioClient
      yield* client.connect()

      const program = Effect.gen(function* () {
        const serverInfo = yield* client.getServerInfo
        const sources = yield* client.listSources

        const requestedSource = Option.getOrUndefined(config.source)
        const sourceName = requestedSource ?? serverInfo.defaultSource

        if (
          requestedSource !== undefined &&
          !sources.some((source) => source.name === requestedSource)
        ) {
          const available = sources.map((source) => source.name ?? "<unnamed>").join(", ")
          return yield* new CliError({
            message: `Unknown source '${requestedSource}'. Available sources: ${available}. Run 'pie sources' to list sources.`,
          })
        }

        yield* Console.log(`[record] Source: ${sourceName}`)

        const byteCountRef = yield* Ref.make(0)
        const chunksRef = yield* Ref.make<ReadonlyArray<Uint8Array>>([])

        const recordFiber = yield* createRecordStream(
          makePcmRecordOptions({
            channels: config.channels,
            rate: config.sampleRate,
            fragmentSize: config.fragmentSize,
            sourceName,
          }),
        ).pipe(
          Stream.runForEach((chunk) =>
            Effect.gen(function* () {
              yield* Ref.update(byteCountRef, (count) => count + chunk.length)
              yield* Ref.update(chunksRef, (chunks) => [...chunks, chunk])
            }),
          ),
          Effect.forkDetach,
        )

        yield* Effect.sleep(`${config.duration} seconds`)
        yield* Fiber.interrupt(recordFiber)

        const byteCount = yield* Ref.get(byteCountRef)
        if (byteCount <= 0) {
          return yield* new CliError({
            message: "No audio data received from PulseAudio",
          })
        }

        const chunks = yield* Ref.get(chunksRef)
        const rawData = concatChunks(chunks)
        const rawRms = pcmRms(rawData)
        const rawPeak = pcmPeak(rawData)

        const bytesPerSecond = config.sampleRate * config.channels * 2
        const expectedBytes = bytesPerSecond * config.duration
        const trimmedRawData =
          rawData.length > expectedBytes ? rawData.slice(0, expectedBytes) : rawData

        const { normalizedBytes: outputData, gain } = config.raw
          ? { normalizedBytes: trimmedRawData, gain: 1.0 }
          : normalizePcmForStt(trimmedRawData)

        if (Option.isSome(config.output)) {
          const outputPath = config.output.value
          yield* Effect.tryPromise({
            try: async () => {
              await mkdirNode(path.dirname(outputPath), { recursive: true })
              await writeNodeFile(outputPath, outputData)
            },
            catch: (cause) =>
              new CliError({
                message: `Failed to write output file: ${String(cause)}`,
                cause,
              }),
          })
        }

        const seconds = outputData.length / bytesPerSecond
        const gainLabel = gain > MIN_GAIN_TO_APPLY ? `gain=${gain.toFixed(2)}` : "gain=1.0"
        const rawLabel = config.raw ? " raw=true" : ""
        const outputLabel = Option.isSome(config.output) ? ` to ${config.output.value}` : ""

        yield* Console.log(
          `Recorded ${outputData.length} bytes (${seconds.toFixed(2)}s) rms=${rawRms.toFixed(4)} peak=${rawPeak.toFixed(4)} ${gainLabel}${rawLabel} source=${sourceName}${outputLabel}`,
        )
      })

      yield* program.pipe(Effect.ensuring(client.disconnect))
    }),
).pipe(Command.withDescription("Record PCM audio from PulseAudio"))
