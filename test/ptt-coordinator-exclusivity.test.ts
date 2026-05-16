import { test } from "node:test"
import * as assert from "node:assert/strict"
import { Effect, Fiber, Layer, Queue } from "effect"

import { runPttLoop, type PttCaptureHandle } from "../src/ptt/loop.js"
import { KeyboardMonitorService, type KeyboardMonitorKeyEvent } from "../src/keyboard/monitor.js"
import { PulseAudioClient } from "../src/pulse/client.js"
import { PA_SAMPLE_FORMAT } from "../src/pulse/defs.js"

const pressEvent = (keysym: number): KeyboardMonitorKeyEvent => ({
  released: false,
  state: 0,
  keysym,
  unichar: 0,
  keycode: 0,
})

const keyboardLayer = (queue: Queue.Queue<KeyboardMonitorKeyEvent>) =>
  Layer.succeed(
    KeyboardMonitorService,
    KeyboardMonitorService.of({
      subscribe: Effect.succeed(queue),
    }),
  )

const pulseLayer = (acquireCalls: Array<string | null>) =>
  Layer.succeed(
    PulseAudioClient,
    PulseAudioClient.of({
      getServerInfo: Effect.die("not used"),
      listSources: Effect.die("not used"),
      openRecordStream: () => Effect.die("not used"),
      closeRecordStream: () => Effect.void,
      acquireRecordStream: (options) =>
        Effect.sync(() => {
          acquireCalls.push(options?.sourceName ?? null)
          return {
            info: {
              streamIndex: 1,
              sourceOutputIndex: 1,
              maximumLength: 0,
              fragmentSize: options?.fragmentSize ?? 0,
              sampleSpec: options?.sampleSpec ?? {
                format: PA_SAMPLE_FORMAT.S16LE,
                channels: 1,
                rate: 16000,
              },
              channelMap: [1],
              sourceIndex: 0,
              sourceName: options?.sourceName ?? null,
              sourceSuspended: false,
              configuredSourceLatencyUsec: 0n,
            },
            queue: Effect.runSync(Queue.unbounded<Uint8Array>()),
          }
        }),
    }),
  )

test("PTT onPress skip does not start audio capture", async () => {
  const keyboardQueue = Effect.runSync(Queue.unbounded<KeyboardMonitorKeyEvent>())
  const acquireCalls: Array<string | null> = []

  const program = Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(
      runPttLoop({
        recognize: (event) => {
          if (event.keysym === 65) {
            return { mode: "transcribe", phase: event.released ? "release" : "press" }
          }
          return undefined
        },
        recordOptions: {
          sampleSpec: { format: PA_SAMPLE_FORMAT.S16LE, channels: 1, rate: 16000 },
          fragmentSize: 1280,
          sourceName: "test-source",
        },
        minDurationMs: 0,
        logPrefix: () => "test",
        onReady: Effect.void,
        onPress: () => Effect.succeed("skip"),
        onRelease: () => Effect.void,
      }),
      { startImmediately: true },
    )

    yield* Queue.offer(keyboardQueue, pressEvent(65))
    yield* Effect.sleep(50)
    yield* Fiber.interrupt(fiber)
  }).pipe(Effect.provide(Layer.mergeAll(keyboardLayer(keyboardQueue), pulseLayer(acquireCalls))))

  await Effect.runPromise(program)
  assert.deepStrictEqual(acquireCalls, [])
})

test("PTT onPress handle starts audio capture", async () => {
  const keyboardQueue = Effect.runSync(Queue.unbounded<KeyboardMonitorKeyEvent>())
  const acquireCalls: Array<string | null> = []

  const handle: PttCaptureHandle = {
    offer: () => Effect.void,
    finish: () => Effect.void,
    cancel: Effect.void,
  }

  const program = Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(
      runPttLoop({
        recognize: (event) => {
          if (event.keysym === 65) {
            return { mode: "transcribe", phase: event.released ? "release" : "press" }
          }
          return undefined
        },
        recordOptions: {
          sampleSpec: { format: PA_SAMPLE_FORMAT.S16LE, channels: 1, rate: 16000 },
          fragmentSize: 1280,
          sourceName: "test-source",
        },
        minDurationMs: 0,
        logPrefix: () => "test",
        onReady: Effect.void,
        onPress: () => Effect.succeed(handle),
        onRelease: () => Effect.void,
      }),
      { startImmediately: true },
    )

    yield* Queue.offer(keyboardQueue, pressEvent(65))
    yield* Effect.sleep(50)
    yield* Fiber.interrupt(fiber)
  }).pipe(Effect.provide(Layer.mergeAll(keyboardLayer(keyboardQueue), pulseLayer(acquireCalls))))

  await Effect.runPromise(program)
  assert.deepStrictEqual(acquireCalls, ["test-source"])
})

test("PTT abort cancels capture and stops audio", async () => {
  const keyboardQueue = Effect.runSync(Queue.unbounded<KeyboardMonitorKeyEvent>())
  const acquireCalls: Array<string | null> = []
  let cancelCalled = false
  let abortChecks = 0

  const handle: PttCaptureHandle = {
    offer: () => Effect.void,
    finish: () => Effect.void,
    cancel: Effect.sync(() => {
      cancelCalled = true
    }),
  }

  const program = Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(
      runPttLoop({
        recognize: (event) => {
          if (event.keysym === 65) {
            return { mode: "transcribe", phase: event.released ? "release" : "press" }
          }
          return undefined
        },
        recordOptions: {
          sampleSpec: { format: PA_SAMPLE_FORMAT.S16LE, channels: 1, rate: 16000 },
          fragmentSize: 1280,
          sourceName: "test-source",
        },
        minDurationMs: 0,
        logPrefix: () => "test",
        onReady: Effect.void,
        onPress: () => Effect.succeed(handle),
        onRelease: () => Effect.void,
        onAbort: Effect.sync(() => {
          abortChecks += 1
          return abortChecks >= 2
        }),
      }),
      { startImmediately: true },
    )

    yield* Queue.offer(keyboardQueue, pressEvent(65))
    yield* Effect.sleep(20)
    yield* Queue.offer(keyboardQueue, {
      released: false,
      state: 0,
      keysym: 999,
      unichar: 0,
      keycode: 0,
    })
    yield* Effect.sleep(20)
    yield* Queue.offer(keyboardQueue, {
      released: false,
      state: 0,
      keysym: 999,
      unichar: 0,
      keycode: 0,
    })
    yield* Effect.sleep(50)
    yield* Fiber.interrupt(fiber)
  }).pipe(Effect.provide(Layer.mergeAll(keyboardLayer(keyboardQueue), pulseLayer(acquireCalls))))

  await Effect.runPromise(program)
  assert.deepStrictEqual(acquireCalls, ["test-source"])
  assert.strictEqual(cancelCalled, true)
})
