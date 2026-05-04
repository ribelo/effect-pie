import { test } from "node:test"
import * as assert from "node:assert/strict"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import * as Data from "effect/Data"
import { promises as fs } from "node:fs"

import { PA_DEFAULT_SOCKET_PATH } from "../src/pulse/defs.ts"
import { layer } from "../src/pulse/client.ts"
import { createWakewordTelemetryStream } from "../src/wakeword/live.ts"
import { createWakewordTriggerMachine } from "../src/wakeword/trigger.ts"

class WakewordLiveTestTimeoutError extends Data.TaggedError("WakewordLiveTestTimeoutError")<{
  readonly message: string
}> {}

const hasPulseSocket = async (): Promise<boolean> => {
  try {
    await fs.access(PA_DEFAULT_SOCKET_PATH)
    return true
  } catch {
    return false
  }
}

test(
  "wakeword live stream emits telemetry when PulseAudio is available",
  { timeout: 20_000 },
  async () => {
    if (!(await hasPulseSocket())) {
      return
    }

    let sampleIndex = 0

    const pipeline = {
      feedPcmChunk: (chunk: Uint8Array) =>
        Effect.succeed([
          {
            timestampMs: sampleIndex / 16,
            sampleIndex,
            scores: {
              jarvis: Math.min(1, chunk.length / 1024),
            },
          },
        ]),
      feedPcmSamples: (_samples: Int16Array) => Effect.succeed([]),
      getFeatureFrameCount: Effect.succeed(0),
      reset: Effect.void,
    }

    const trigger = Effect.runSync(
      createWakewordTriggerMachine({
        threshold: 0.5,
        smoothingWindow: 1,
        consecutiveFrames: 1,
        cooldownMs: 200,
      }),
    )

    const program = createWakewordTelemetryStream({
      pipeline,
      trigger,
      recordStream: {
        fragmentSize: 1024,
      },
    }).pipe(
      Stream.tap((event) =>
        Effect.sync(() => {
          if (event.type === "score") {
            sampleIndex += 1_280
          }
        }),
      ),
      Stream.take(3),
      Stream.runCollect,
      Effect.timeoutOrElse({
        duration: "10 seconds",
        orElse: () =>
          Effect.fail(
            new WakewordLiveTestTimeoutError({ message: "wakeword live stream timed out" }),
          ),
      }),
      Effect.provide(layer()),
    )

    const events = await Effect.runPromise(program)
    assert.ok(events.length > 0)
  },
)
