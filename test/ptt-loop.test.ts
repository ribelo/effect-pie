import { describe, it } from "node:test"
import { strict as assert } from "node:assert"
import { Effect, Fiber, Queue, Ref } from "effect"

import { KeyboardMonitorService, type KeyboardMonitorKeyEvent } from "../src/keyboard/monitor.js"
import { PulseAudioClient, type OpenRecordStream } from "../src/pulse/client.js"
import { PA_SAMPLE_FORMAT } from "../src/pulse/defs.js"
import { runPttLoop } from "../src/ptt/loop.js"

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

const makeFakeServices = (
  keyQueue: Queue.Queue<KeyboardMonitorKeyEvent>,
  audioQueue: Queue.Queue<Uint8Array>,
) => ({
  keyboard: KeyboardMonitorService.of({
    subscribe: Effect.succeed(keyQueue),
  }),
  pulse: PulseAudioClient.of({
    getServerInfo: Effect.die("unused"),
    listSources: Effect.die("unused"),
    openRecordStream: () => Effect.succeed(recordStream(audioQueue)),
    closeRecordStream: () => Effect.void,
    acquireRecordStream: () => Effect.succeed(recordStream(audioQueue)),
  }),
})

describe("runPttLoop edge cases", () => {
  it("onPress returning 'skip' drops press without dirtying state", async () => {
    let pressCount = 0
    let offerCount = 0
    let finishCount = 0
    let cancelCount = 0

    const program = Effect.scoped(
      Effect.gen(function* () {
        const keyQueue = yield* Queue.unbounded<KeyboardMonitorKeyEvent>()
        const audioQueue = yield* Queue.unbounded<Uint8Array>()
        const { keyboard, pulse } = makeFakeServices(keyQueue, audioQueue)

        const skipRef = yield* Ref.make(true)

        const fiber = yield* runPttLoop({
          recognize: (event) =>
            event.keycode === 456
              ? { mode: "test", phase: event.released ? "release" : "press" }
              : undefined,
          recordOptions: {
            sampleSpec: { format: PA_SAMPLE_FORMAT.S16LE, channels: 1, rate: 24_000 },
            fragmentSize: 1024,
            sourceName: null,
          },
          minDurationMs: 1,
          logPrefix: () => "test",
          onReady: Effect.void,
          onPress: () =>
            Effect.gen(function* () {
              const shouldSkip = yield* Ref.get(skipRef)
              if (shouldSkip) {
                yield* Ref.set(skipRef, false)
                return "skip" as const
              }
              pressCount += 1
              return {
                offer: () =>
                  Effect.sync(() => {
                    offerCount += 1
                  }),
                finish: () =>
                  Effect.sync(() => {
                    finishCount += 1
                  }),
                cancel: Effect.sync(() => {
                  cancelCount += 1
                }),
              }
            }),
        }).pipe(
          Effect.provideService(KeyboardMonitorService, keyboard),
          Effect.provideService(PulseAudioClient, pulse),
          Effect.forkScoped,
        )

        yield* Queue.offer(keyQueue, keyDown)
        yield* Effect.sleep("5 millis")
        yield* Queue.offer(keyQueue, keyUp)

        yield* Effect.sleep("10 millis")

        yield* Queue.offer(keyQueue, keyDown)
        yield* Effect.sleep("5 millis")
        yield* Queue.offer(audioQueue, new Uint8Array([4, 5, 6]))
        yield* Queue.offer(keyQueue, keyUp)

        yield* Effect.sleep("2100 millis")
        yield* Fiber.interrupt(fiber)
      }),
    )

    await Effect.runPromise(program)

    assert.strictEqual(pressCount, 1)
    assert.strictEqual(offerCount, 1)
    assert.strictEqual(finishCount, 1)
    assert.strictEqual(cancelCount, 0)
  })

  it("onAbort true mid-capture tears down and resumes from clean state", async () => {
    let cancelCount = 0
    let pressCount = 0

    const program = Effect.scoped(
      Effect.gen(function* () {
        const keyQueue = yield* Queue.unbounded<KeyboardMonitorKeyEvent>()
        const audioQueue = yield* Queue.unbounded<Uint8Array>()
        const { keyboard, pulse } = makeFakeServices(keyQueue, audioQueue)

        const abortRef = yield* Ref.make(false)

        const fiber = yield* runPttLoop({
          recognize: (event) =>
            event.keycode === 456
              ? { mode: "test", phase: event.released ? "release" : "press" }
              : undefined,
          recordOptions: {
            sampleSpec: { format: PA_SAMPLE_FORMAT.S16LE, channels: 1, rate: 24_000 },
            fragmentSize: 1024,
            sourceName: null,
          },
          minDurationMs: 1,
          logPrefix: () => "test",
          onReady: Effect.void,
          onPress: () =>
            Effect.sync(() => {
              pressCount += 1
              return {
                offer: () => Effect.void,
                finish: () => Effect.void,
                cancel: Effect.sync(() => {
                  cancelCount += 1
                }),
              }
            }),
          onAbort: Ref.get(abortRef),
        }).pipe(
          Effect.provideService(KeyboardMonitorService, keyboard),
          Effect.provideService(PulseAudioClient, pulse),
          Effect.forkScoped,
        )

        yield* Queue.offer(keyQueue, keyDown)
        yield* Queue.offer(audioQueue, new Uint8Array([1, 2, 3]))

        yield* Effect.sleep("5 millis")
        yield* Ref.set(abortRef, true)
        yield* Queue.offer(keyQueue, { ...keyDown, keycode: 999 })

        yield* Effect.sleep("20 millis")

        yield* Ref.set(abortRef, false)
        yield* Queue.offer(keyQueue, keyDown)
        yield* Effect.sleep("5 millis")
        yield* Queue.offer(audioQueue, new Uint8Array([4, 5, 6]))
        yield* Queue.offer(keyQueue, keyUp)

        yield* Effect.sleep("10 millis")
        yield* Fiber.interrupt(fiber)
      }),
    )

    await Effect.runPromise(program)

    assert.strictEqual(cancelCount, 1)
    assert.strictEqual(pressCount, 2)
  })

  it("post-roll re-press continues original capture", async () => {
    let pressCount = 0
    const offeredChunks: Array<Array<number>> = []
    let finishCount = 0

    const program = Effect.scoped(
      Effect.gen(function* () {
        const keyQueue = yield* Queue.unbounded<KeyboardMonitorKeyEvent>()
        const audioQueue = yield* Queue.unbounded<Uint8Array>()
        const { keyboard, pulse } = makeFakeServices(keyQueue, audioQueue)

        const fiber = yield* runPttLoop({
          recognize: (event) =>
            event.keycode === 456
              ? { mode: "test", phase: event.released ? "release" : "press" }
              : undefined,
          recordOptions: {
            sampleSpec: { format: PA_SAMPLE_FORMAT.S16LE, channels: 1, rate: 24_000 },
            fragmentSize: 1024,
            sourceName: null,
          },
          minDurationMs: 1,
          logPrefix: () => "test",
          onReady: Effect.void,
          onPress: () =>
            Effect.sync(() => {
              pressCount += 1
              return {
                offer: (chunk) =>
                  Effect.sync(() => {
                    offeredChunks.push([...chunk])
                  }),
                finish: () =>
                  Effect.sync(() => {
                    finishCount += 1
                  }),
                cancel: Effect.void,
              }
            }),
        }).pipe(
          Effect.provideService(KeyboardMonitorService, keyboard),
          Effect.provideService(PulseAudioClient, pulse),
          Effect.forkScoped,
        )

        yield* Queue.offer(keyQueue, keyDown)
        yield* Queue.offer(audioQueue, new Uint8Array([1]))
        yield* Queue.offer(keyQueue, keyUp)

        yield* Effect.sleep("100 millis")

        yield* Queue.offer(keyQueue, keyDown)
        yield* Queue.offer(audioQueue, new Uint8Array([2]))
        yield* Queue.offer(keyQueue, keyUp)

        yield* Effect.sleep("2500 millis")
        yield* Fiber.interrupt(fiber)
      }),
    )

    await Effect.runPromise(program)

    assert.strictEqual(pressCount, 1)
    assert.strictEqual(finishCount, 1)
    assert.deepStrictEqual(offeredChunks, [[1], [2]])
  })

  it("release finishes handle work forked from audio offers before stopping audio", async () => {
    let finishCount = 0
    let prematureExit: string | undefined

    const program = Effect.scoped(
      Effect.gen(function* () {
        const keyQueue = yield* Queue.unbounded<KeyboardMonitorKeyEvent>()
        const audioQueue = yield* Queue.unbounded<Uint8Array>()
        const doneQueue = yield* Queue.unbounded<void>()
        const childRef = yield* Ref.make<Fiber.Fiber<void> | undefined>(undefined)
        const { keyboard, pulse } = makeFakeServices(keyQueue, audioQueue)

        const fiber = yield* runPttLoop({
          recognize: (event) =>
            event.keycode === 456
              ? { mode: "test", phase: event.released ? "release" : "press" }
              : undefined,
          recordOptions: {
            sampleSpec: { format: PA_SAMPLE_FORMAT.S16LE, channels: 1, rate: 24_000 },
            fragmentSize: 1024,
            sourceName: null,
          },
          minDurationMs: 1,
          logPrefix: () => "test",
          onReady: Effect.void,
          onPress: () =>
            Effect.succeed({
              offer: () =>
                Effect.gen(function* () {
                  const existing = yield* Ref.get(childRef)
                  if (existing !== undefined) {
                    return
                  }

                  const child = yield* Queue.take(doneQueue).pipe((effect) =>
                    Effect.forkChild(effect, { startImmediately: true }),
                  )
                  yield* Ref.set(childRef, child)
                }),
              finish: () =>
                Effect.gen(function* () {
                  const child = yield* Ref.get(childRef)
                  if (child === undefined) {
                    return yield* Effect.die("expected streamed child fiber")
                  }

                  yield* Queue.offer(doneQueue, undefined)
                  yield* Fiber.join(child)
                  finishCount += 1
                }),
              cancel: Effect.void,
            }),
        }).pipe(
          Effect.provideService(KeyboardMonitorService, keyboard),
          Effect.provideService(PulseAudioClient, pulse),
          Effect.forkScoped,
        )

        yield* Queue.offer(keyQueue, keyDown)
        yield* Effect.sleep("5 millis")
        yield* Queue.offer(audioQueue, new Uint8Array([1, 2, 3, 4]))
        yield* Queue.offer(keyQueue, keyUp)

        yield* Effect.sleep("2100 millis")
        const exit = yield* Fiber.await(fiber).pipe(
          Effect.timeoutOrElse({
            duration: "10 millis",
            orElse: () => Effect.void,
          }),
        )
        if (exit !== undefined) {
          prematureExit = String(exit)
        }
        yield* Fiber.interrupt(fiber).pipe(Effect.ignore)
      }),
    )

    await Effect.runPromise(program)

    assert.strictEqual(prematureExit, undefined)
    assert.strictEqual(finishCount, 1)
  })

  it("dead-input detector fires during active hold", async () => {
    let cancelCount = 0
    let finishCount = 0

    const program = Effect.scoped(
      Effect.gen(function* () {
        const keyQueue = yield* Queue.unbounded<KeyboardMonitorKeyEvent>()
        const audioQueue = yield* Queue.unbounded<Uint8Array>()
        const { keyboard, pulse } = makeFakeServices(keyQueue, audioQueue)

        const fiber = yield* runPttLoop({
          recognize: (event) =>
            event.keycode === 456
              ? { mode: "test", phase: event.released ? "release" : "press" }
              : undefined,
          recordOptions: {
            sampleSpec: { format: PA_SAMPLE_FORMAT.S16LE, channels: 1, rate: 24_000 },
            fragmentSize: 1024,
            sourceName: null,
          },
          minDurationMs: 1,
          logPrefix: () => "test",
          onReady: Effect.void,
          onPress: () =>
            Effect.sync(() => ({
              offer: () => Effect.void,
              finish: () =>
                Effect.sync(() => {
                  finishCount += 1
                }),
              cancel: Effect.sync(() => {
                cancelCount += 1
              }),
            })),
        }).pipe(
          Effect.provideService(KeyboardMonitorService, keyboard),
          Effect.provideService(PulseAudioClient, pulse),
          Effect.forkScoped,
        )

        yield* Queue.offer(keyQueue, keyDown)
        yield* Queue.offer(audioQueue, new Uint8Array(1024))
        yield* Queue.offer(audioQueue, new Uint8Array(1024))
        yield* Queue.offer(audioQueue, new Uint8Array(1024))
        yield* Queue.offer(audioQueue, new Uint8Array(1024))

        yield* Effect.sleep("10 millis")
        yield* Fiber.interrupt(fiber)
      }),
    )

    await Effect.runPromise(program)

    assert.strictEqual(cancelCount, 1)
    assert.strictEqual(finishCount, 0)
  })

  it("rapid press cycles isolate chunks per handle", { timeout: 15000 }, async () => {
    let pressCount = 0
    let finishCount = 0
    const handleChunks: Array<Array<Array<number>>> = []

    const program = Effect.scoped(
      Effect.gen(function* () {
        const keyQueue = yield* Queue.unbounded<KeyboardMonitorKeyEvent>()
        const audioQueue = yield* Queue.unbounded<Uint8Array>()
        const { keyboard, pulse } = makeFakeServices(keyQueue, audioQueue)

        const fiber = yield* runPttLoop({
          recognize: (event) =>
            event.keycode === 456
              ? { mode: "test", phase: event.released ? "release" : "press" }
              : undefined,
          recordOptions: {
            sampleSpec: { format: PA_SAMPLE_FORMAT.S16LE, channels: 1, rate: 24_000 },
            fragmentSize: 1024,
            sourceName: null,
          },
          minDurationMs: 1,
          logPrefix: () => "test",
          onReady: Effect.void,
          onPress: () =>
            Effect.sync(() => {
              const handleIndex = pressCount
              pressCount += 1
              handleChunks[handleIndex] = []
              return {
                offer: (chunk) =>
                  Effect.sync(() => {
                    handleChunks[handleIndex]!.push([...chunk])
                  }),
                finish: () =>
                  Effect.sync(() => {
                    finishCount += 1
                  }),
                cancel: Effect.void,
              }
            }),
        }).pipe(
          Effect.provideService(KeyboardMonitorService, keyboard),
          Effect.provideService(PulseAudioClient, pulse),
          Effect.forkScoped,
        )

        for (let cycle = 0; cycle < 2; cycle++) {
          yield* Queue.offer(keyQueue, keyDown)
          yield* Effect.sleep("5 millis")
          yield* Queue.offer(audioQueue, new Uint8Array([cycle, 1]))
          yield* Queue.offer(audioQueue, new Uint8Array([cycle, 2]))
          yield* Queue.offer(keyQueue, keyUp)
          yield* Effect.sleep("2100 millis")
        }
        yield* Fiber.interrupt(fiber)
      }),
    )

    await Effect.runPromise(program)

    assert.strictEqual(pressCount, 2)
    assert.strictEqual(finishCount, 2)
    assert.strictEqual(handleChunks.length, 2)
    for (let cycle = 0; cycle < 2; cycle++) {
      assert.deepStrictEqual(handleChunks[cycle], [
        [cycle, 1],
        [cycle, 2],
      ])
    }
  })
})
