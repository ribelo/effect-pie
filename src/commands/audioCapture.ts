import { Deferred, Effect, Fiber, Ref, Stream } from "effect"
import { makePcmRecordOptions, type SourceInfo } from "../pulse/defs.js"
import { createRecordStream } from "../pulse/stream.js"
import type { PulseAudioClient, PulseAudioClientError } from "../pulse/client.js"
import { pcmPeak, pcmRms } from "../audio/pcm.js"
import {
  concatChunks,
  percentile,
  waitForEnter,
  CliError,
  NoSpeechDetectedError,
} from "./shared.js"
import { WakewordTrainingError } from "../wakeword/training.js"

export type AudioMetrics = {
  readonly chunkCount: number
  readonly rmsValues: ReadonlyArray<number>
  readonly peakValues: ReadonlyArray<number>
  readonly maxRms: number
  readonly maxPeak: number
  readonly rmsP50: number
  readonly rmsP80: number
  readonly rmsP95: number
}

export const isMonitorSource = (source: SourceInfo): boolean => {
  const name = source.name?.toLowerCase() ?? ""
  const description = source.description?.toLowerCase() ?? ""
  return name.includes(".monitor") || description.startsWith("monitor of")
}

export const sourceProbeScore = (metrics: AudioMetrics): number =>
  Math.max(0, metrics.rmsP95 - metrics.rmsP50) * 4 + metrics.maxRms

export const collectAudioMetricsInteractive = Effect.fn(
  "pie/commands/audioCapture.collectAudioMetricsInteractive",
)(function* (config: {
  readonly fragmentSize: number
  readonly sampleRate: number
  readonly channels: number
  readonly sourceName: string
  readonly startPrompt: string
  readonly stopPrompt: string
}): Effect.fn.Return<AudioMetrics, Error | WakewordTrainingError, PulseAudioClient> {
  yield* waitForEnter(config.startPrompt).pipe(
    Effect.mapError(
      (cause) =>
        new WakewordTrainingError({
          message: cause.message,
          cause,
        }),
    ),
  )

  const rmsValuesRef = yield* Ref.make<Array<number>>([])
  const peakValuesRef = yield* Ref.make<Array<number>>([])

  const recordOptions = makePcmRecordOptions({
    channels: config.channels,
    rate: config.sampleRate,
    fragmentSize: config.fragmentSize,
    sourceName: config.sourceName,
  })

  yield* Effect.scoped(
    Effect.gen(function* () {
      yield* createRecordStream(recordOptions).pipe(
        Stream.runForEach((chunk) =>
          Effect.gen(function* () {
            yield* Ref.update(rmsValuesRef, (values) => [...values, pcmRms(chunk)])
            yield* Ref.update(peakValuesRef, (values) => [...values, pcmPeak(chunk)])
          }),
        ),
        Effect.forkScoped,
      )

      yield* waitForEnter(config.stopPrompt).pipe(
        Effect.mapError(
          (cause) =>
            new WakewordTrainingError({
              message: cause.message,
              cause,
            }),
        ),
      )
    }),
  )

  const rmsValues = yield* Ref.get(rmsValuesRef)
  const peakValues = yield* Ref.get(peakValuesRef)

  if (rmsValues.length === 0) {
    return yield* new CliError({
      message: "No audio captured while collecting metrics",
    })
  }

  return {
    chunkCount: rmsValues.length,
    rmsValues,
    peakValues,
    maxRms: rmsValues.reduce((max, value) => (value > max ? value : max), 0),
    maxPeak: peakValues.reduce((max, value) => (value > max ? value : max), 0),
    rmsP50: percentile(rmsValues, 0.5),
    rmsP80: percentile(rmsValues, 0.8),
    rmsP95: percentile(rmsValues, 0.95),
  }
})

export const recordVoiceActivatedClip = Effect.fn(
  "pie/commands/audioCapture.recordVoiceActivatedClip",
)(function* (config: {
  readonly clipSeconds: number
  readonly maxWaitSeconds: number
  readonly speechRmsThreshold: number
  readonly minActiveChunks: number
  readonly preRollMs: number
  readonly fragmentSize: number
  readonly sampleRate: number
  readonly channels: number
  readonly sourceName?: string
}): Effect.fn.Return<Uint8Array, Error, PulseAudioClient> {
  const bytesPerSecond = config.sampleRate * config.channels * 2
  const targetBytes = Math.max(1, Math.round(bytesPerSecond * config.clipSeconds))
  const preRollBytes = Math.round((bytesPerSecond * config.preRollMs) / 1000)
  const preRollChunks = Math.max(1, Math.ceil(preRollBytes / config.fragmentSize))

  const completion = yield* Deferred.make<Uint8Array, Error>()
  const preRollRef = yield* Ref.make<ReadonlyArray<Uint8Array>>([])
  const collectedRef = yield* Ref.make<ReadonlyArray<Uint8Array>>([])
  const collectedBytesRef = yield* Ref.make(0)
  const activeChunksRef = yield* Ref.make(0)
  const startedRef = yield* Ref.make(false)
  const maxObservedRmsRef = yield* Ref.make(0)
  const startedAt = Date.now()

  const recordOptions = makePcmRecordOptions({
    channels: config.channels,
    rate: config.sampleRate,
    fragmentSize: config.fragmentSize,
    sourceName: config.sourceName,
  })

  const result = yield* Effect.scoped(
    Effect.gen(function* () {
      const streamFiber = yield* createRecordStream(recordOptions).pipe(
        Stream.runForEach((chunk) =>
          Effect.gen(function* () {
            const elapsedSeconds = (Date.now() - startedAt) / 1000
            const started = yield* Ref.get(startedRef)
            const rms = pcmRms(chunk)
            yield* Ref.update(maxObservedRmsRef, (current) => (rms > current ? rms : current))

            if (!started && elapsedSeconds > config.maxWaitSeconds) {
              const observedMaxRms = yield* Ref.get(maxObservedRmsRef)
              yield* Deferred.complete(
                completion,
                Effect.fail(
                  new NoSpeechDetectedError({
                    message: `No speech detected within ${config.maxWaitSeconds.toFixed(1)}s (max RMS ${observedMaxRms.toFixed(4)} < threshold ${config.speechRmsThreshold.toFixed(4)})`,
                    observedMaxRms,
                    threshold: config.speechRmsThreshold,
                  }),
                ),
              )
              return
            }

            if (!started) {
              const preRoll = yield* Ref.get(preRollRef)
              const updatedPreRoll = [...preRoll, chunk].slice(-preRollChunks)
              yield* Ref.set(preRollRef, updatedPreRoll)

              if (rms >= config.speechRmsThreshold) {
                const active = yield* Ref.updateAndGet(activeChunksRef, (value) => value + 1)
                if (active < config.minActiveChunks) {
                  return
                }

                yield* Ref.set(startedRef, true)
                yield* Ref.set(collectedRef, updatedPreRoll)
                yield* Ref.set(
                  collectedBytesRef,
                  updatedPreRoll.reduce((sum, item) => sum + item.length, 0),
                )
                return
              }

              yield* Ref.set(activeChunksRef, 0)
              return
            }

            const collected = yield* Ref.get(collectedRef)
            const next = [...collected, chunk]
            yield* Ref.set(collectedRef, next)

            const bytes = yield* Ref.updateAndGet(
              collectedBytesRef,
              (value) => value + chunk.length,
            )
            if (bytes >= targetBytes) {
              yield* Deferred.complete(completion, Effect.succeed(concatChunks(next)))
            }
          }),
        ),
        Effect.forkScoped,
      )

      return yield* Deferred.await(completion).pipe(
        Effect.raceFirst(
          Fiber.join(streamFiber).pipe(
            Effect.flatMap(() =>
              Effect.fail(
                new CliError({
                  message: "PulseAudio record stream ended before recording completed",
                }),
              ),
            ),
          ),
        ),
        Effect.timeoutOrElse({
          duration: `${Math.ceil(config.maxWaitSeconds + config.clipSeconds + 2)} seconds`,
          orElse: () =>
            Ref.get(maxObservedRmsRef).pipe(
              Effect.flatMap((observedMaxRms) =>
                Effect.fail(
                  new NoSpeechDetectedError({
                    message: `Recording timed out before collecting voice clip (max RMS ${observedMaxRms.toFixed(4)} < threshold ${config.speechRmsThreshold.toFixed(4)})`,
                    observedMaxRms,
                    threshold: config.speechRmsThreshold,
                  }),
                ),
              ),
            ),
        }),
      )
    }),
  )

  return result
})

export const recordPcmClip = Effect.fn("pie/commands/audioCapture.recordPcmClip")(
  function* (config: {
    readonly durationSeconds: number
    readonly fragmentSize: number
    readonly sampleRate: number
    readonly channels: number
    readonly sourceName?: string
  }): Effect.fn.Return<Uint8Array, Error, PulseAudioClient> {
    const chunksRef = yield* Ref.make<ReadonlyArray<Uint8Array>>([])

    const recordOptions = makePcmRecordOptions({
      channels: config.channels,
      rate: config.sampleRate,
      fragmentSize: config.fragmentSize,
      sourceName: config.sourceName,
    })

    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* createRecordStream(recordOptions).pipe(
          Stream.runForEach((chunk) => Ref.update(chunksRef, (chunks) => [...chunks, chunk])),
          Effect.forkScoped,
        )

        yield* Effect.sleep(`${config.durationSeconds} seconds`)
      }),
    )

    const chunks = yield* Ref.get(chunksRef)
    if (chunks.length === 0) {
      return yield* new CliError({
        message: "No audio captured for training clip",
      })
    }

    return concatChunks(chunks)
  },
)

export const recordPcmUntilTrailingSilence = Effect.fn(
  "pie/commands/audioCapture.recordPcmUntilTrailingSilence",
)(function* (config: {
  readonly silenceSeconds: number
  readonly maxSeconds: number
  readonly speechStartTimeoutSeconds?: number
  readonly speechRmsThreshold: number
  readonly fragmentSize: number
  readonly sampleRate: number
  readonly channels: number
  readonly sourceName?: string
}): Effect.fn.Return<
  Uint8Array,
  NoSpeechDetectedError | CliError | PulseAudioClientError,
  PulseAudioClient
> {
  const bytesPerSecond = config.sampleRate * config.channels * 2
  const chunkDurationSeconds = config.fragmentSize / bytesPerSecond
  const silenceChunksTarget = Math.max(1, Math.ceil(config.silenceSeconds / chunkDurationSeconds))
  const speechStartTimeoutSeconds = Math.min(
    config.maxSeconds,
    config.speechStartTimeoutSeconds ?? config.maxSeconds,
  )

  const completion = yield* Deferred.make<Uint8Array, NoSpeechDetectedError | CliError>()
  const chunksRef = yield* Ref.make<ReadonlyArray<Uint8Array>>([])
  const capturedChunksRef = yield* Ref.make(0)
  const seenSpeechRef = yield* Ref.make(false)
  const silenceChunksRef = yield* Ref.make(0)
  const maxObservedRmsRef = yield* Ref.make(0)

  const recordOptions = makePcmRecordOptions({
    channels: config.channels,
    rate: config.sampleRate,
    fragmentSize: config.fragmentSize,
    sourceName: config.sourceName,
  })

  const result = yield* Effect.scoped(
    Effect.gen(function* () {
      const streamFiber = yield* createRecordStream(recordOptions).pipe(
        Stream.runForEach((chunk) =>
          Effect.gen(function* () {
            yield* Ref.update(chunksRef, (chunks) => [...chunks, chunk])

            const capturedChunks = yield* Ref.updateAndGet(capturedChunksRef, (value) => value + 1)
            const rms = pcmRms(chunk)
            yield* Ref.update(maxObservedRmsRef, (current) => (rms > current ? rms : current))

            if (rms >= config.speechRmsThreshold) {
              yield* Ref.set(seenSpeechRef, true)
              yield* Ref.set(silenceChunksRef, 0)
              return
            }

            const seenSpeech = yield* Ref.get(seenSpeechRef)
            if (!seenSpeech) {
              const elapsedSeconds = capturedChunks * chunkDurationSeconds
              if (elapsedSeconds >= speechStartTimeoutSeconds) {
                const observed = yield* Ref.get(maxObservedRmsRef)
                yield* Deferred.complete(
                  completion,
                  Effect.fail(
                    new NoSpeechDetectedError({
                      message: `No speech detected within ${speechStartTimeoutSeconds.toFixed(1)}s (max RMS ${observed.toFixed(4)} < threshold ${config.speechRmsThreshold.toFixed(4)})`,
                      observedMaxRms: observed,
                      threshold: config.speechRmsThreshold,
                    }),
                  ),
                )
              }
              return
            }

            const silenceChunks = yield* Ref.updateAndGet(silenceChunksRef, (value) => value + 1)
            if (silenceChunks >= silenceChunksTarget) {
              const chunks = yield* Ref.get(chunksRef)
              yield* Deferred.complete(completion, Effect.succeed(concatChunks(chunks)))
            }
          }),
        ),
        Effect.forkScoped,
      )

      return yield* Deferred.await(completion).pipe(
        Effect.raceFirst(
          Fiber.join(streamFiber).pipe(
            Effect.flatMap(() =>
              Effect.fail(
                new CliError({
                  message: "PulseAudio record stream ended before recording completed",
                }),
              ),
            ),
          ),
        ),
        Effect.timeoutOrElse({
          duration: `${Math.ceil(config.maxSeconds + 2)} seconds`,
          orElse: () =>
            Effect.gen(function* () {
              const chunks = yield* Ref.get(chunksRef)
              const seenSpeech = yield* Ref.get(seenSpeechRef)

              if (seenSpeech && chunks.length > 0) {
                return concatChunks(chunks)
              }

              const observed = yield* Ref.get(maxObservedRmsRef)
              return yield* new NoSpeechDetectedError({
                message: `No speech detected before timeout (${config.maxSeconds.toFixed(1)}s, max RMS ${observed.toFixed(4)} < threshold ${config.speechRmsThreshold.toFixed(4)})`,
                observedMaxRms: observed,
                threshold: config.speechRmsThreshold,
              })
            }),
        }),
      )
    }),
  )

  if (result.length === 0) {
    return yield* new CliError({
      message: "No audio captured for wakeword dictation",
    })
  }

  return result
})
