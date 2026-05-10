import { test } from "node:test"
import * as assert from "node:assert/strict"
import { Effect, Fiber, Option, Queue } from "effect"

import { KeyboardMonitorService, type KeyboardMonitorKeyEvent } from "../src/keyboard/monitor.js"
import { PulseAudioClient, type OpenRecordStream } from "../src/pulse/client.js"
import { PA_SAMPLE_FORMAT } from "../src/pulse/defs.js"
import { runKeyboardMonitorPtt } from "../src/commands/ptt.js"

const keyDown: KeyboardMonitorKeyEvent = {
  released: false,
  state: 0,
  keysym: 123,
  unichar: 0,
  keycode: 456,
}

const keyUp: KeyboardMonitorKeyEvent = {
  ...keyDown,
  released: true,
}

const recordStream = (queue: Queue.Queue<Uint8Array>): OpenRecordStream => ({
  queue,
  info: {
    streamIndex: 1,
    sourceOutputIndex: 1,
    maximumLength: 0,
    fragmentSize: 1024,
    sampleSpec: { format: PA_SAMPLE_FORMAT.S16LE, channels: 1, rate: 24_000 },
    channelMap: [1],
    sourceIndex: 1,
    sourceName: "test-source",
    sourceSuspended: false,
    configuredSourceLatencyUsec: 0n,
  },
})

test("runKeyboardMonitorPtt aborts muted flatline captures before streaming or clip handling", async () => {
  let offeredChunks = 0
  let finishedCaptures = 0
  let handledClips = 0

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const keyQueue = yield* Queue.unbounded<KeyboardMonitorKeyEvent>()
        const audioQueue = yield* Queue.unbounded<Uint8Array>()

        const fakeKeyboard = KeyboardMonitorService.of({
          subscribe: Effect.succeed(keyQueue),
        })
        const fakePulse = PulseAudioClient.of({
          getServerInfo: Effect.die("unused"),
          listSources: Effect.die("unused"),
          openRecordStream: () => Effect.succeed(recordStream(audioQueue)),
          closeRecordStream: () => Effect.void,
          acquireRecordStream: () => Effect.succeed(recordStream(audioQueue)),
        })

        const fiber = yield* runKeyboardMonitorPtt({
          keycode: Option.some(456),
          keysym: Option.none(),
          source: Option.none(),
          minDurationMs: 1,
          sampleRate: 24_000,
          fragmentSize: 1024,
          logPrefix: "test-ptt",
          armedMessage: () => "armed",
          onCaptureStart: () =>
            Effect.succeed({
              offer: () =>
                Effect.sync(() => {
                  offeredChunks += 1
                }),
              finish: () =>
                Effect.sync(() => {
                  finishedCaptures += 1
                }),
              cancel: Effect.void,
            }),
          onClip: () =>
            Effect.sync(() => {
              handledClips += 1
            }),
        }).pipe(
          Effect.provideService(KeyboardMonitorService, fakeKeyboard),
          Effect.provideService(PulseAudioClient, fakePulse),
          Effect.forkScoped,
        )

        yield* Queue.offer(keyQueue, keyDown)
        yield* Queue.offer(audioQueue, new Uint8Array(1024))
        yield* Queue.offer(audioQueue, new Uint8Array(1024))
        yield* Queue.offer(audioQueue, new Uint8Array(1024))
        yield* Queue.offer(audioQueue, new Uint8Array(1024))
        yield* Queue.offer(keyQueue, keyUp)
        yield* Effect.sleep("10 millis")
        yield* Fiber.interrupt(fiber)
      }),
    ),
  )

  assert.strictEqual(offeredChunks, 0)
  assert.strictEqual(finishedCaptures, 0)
  assert.strictEqual(handledClips, 0)
})
