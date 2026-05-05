import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Queue from "effect/Queue"
import * as Stream from "effect/Stream"

import type { PulseAudioClient } from "../pulse/client.js"
import { PA_SAMPLE_FORMAT, type RecordStreamOptions } from "../pulse/defs.js"
import { createRecordStream } from "../pulse/stream.js"
import {
  OPENWAKEWORD_CHANNELS,
  OPENWAKEWORD_SAMPLE_RATE,
  type WakewordScoreFrame,
  type WakewordTriggerEvent,
} from "./defs.js"
import type { WakewordPipeline } from "./pipeline.js"
import type { WakewordTriggerMachine } from "./trigger.js"

export class WakewordLiveError extends Data.TaggedError("WakewordLiveError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

export type WakewordTelemetryEvent =
  | {
      readonly type: "score"
      readonly frame: WakewordScoreFrame
    }
  | {
      readonly type: "trigger"
      readonly event: WakewordTriggerEvent
    }

export type WakewordLiveConfig = {
  readonly pipeline: WakewordPipeline
  readonly trigger: WakewordTriggerMachine
  readonly recordStream?: Partial<RecordStreamOptions>
}

const defaultRecordStream: Partial<RecordStreamOptions> = {
  sampleSpec: {
    format: PA_SAMPLE_FORMAT.S16LE,
    channels: OPENWAKEWORD_CHANNELS,
    rate: OPENWAKEWORD_SAMPLE_RATE,
  },
  fragmentSize: 1_280 * 2,
}

export const createWakewordTelemetryStream = (
  config: WakewordLiveConfig,
): Stream.Stream<WakewordTelemetryEvent, WakewordLiveError, PulseAudioClient> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<WakewordTelemetryEvent>()

      const processingEffect = createRecordStream({
        ...defaultRecordStream,
        ...config.recordStream,
      }).pipe(
        Stream.runForEach((chunk) =>
          Effect.gen(function* () {
            const scoreFrames = yield* config.pipeline.feedPcmChunk(chunk).pipe(
              Effect.mapError(
                (cause) =>
                  new WakewordLiveError({
                    message: "Wakeword pipeline failed while processing audio",
                    cause,
                  }),
              ),
            )

            for (const frame of scoreFrames) {
              yield* Queue.offer(queue, {
                type: "score",
                frame,
              })

              const triggerEvents = config.trigger.processFrame(frame)
              for (const event of triggerEvents) {
                yield* Queue.offer(queue, {
                  type: "trigger",
                  event,
                })
              }
            }
          }),
        ),
      )

      yield* Effect.matchEffect(processingEffect, {
        onFailure: (cause) =>
          Queue.shutdown(queue).pipe(
            Effect.andThen(
              Effect.logError(
                new WakewordLiveError({
                  message: "Wakeword live stream failed",
                  cause,
                }),
              ),
            ),
          ),
        onSuccess: () => Queue.shutdown(queue),
      }).pipe(Effect.forkScoped)

      yield* Effect.addFinalizer(() => Queue.shutdown(queue))

      return Stream.fromQueue(queue)
    }),
  )
