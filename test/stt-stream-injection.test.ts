import { test } from "node:test"
import * as assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { Effect, Fiber, Queue, Stream, type Cause } from "effect"

import { DesktopSession } from "../src/desktop/session.js"
import { TextInjectionBackendService } from "../src/input/textInjection.js"
import { SttService } from "../src/stt/service.js"
import { transcribeStreamAndInject } from "../src/stt/transcribeAndInject.js"

test("transcribeStreamAndInject streams chunks and does not duplicate final text", async () => {
  const receivedChunks: Array<Array<number>> = []
  const typedDeltas: Array<string> = []

  const fakeStt = SttService.of({
    provider: "codex-realtime",
    transcribe: () => Effect.succeed("unused"),
    translate: () => Effect.succeed("unused"),
    transcribeStream: (config) =>
      config.audio.pipe(
        Stream.runForEach((chunk) =>
          Effect.gen(function* () {
            receivedChunks.push([...chunk])
            const delta = chunk[0] === 1 ? "hel" : "lo"
            if (config.onDelta !== undefined) {
              yield* config.onDelta(delta)
            }
          }),
        ),
        Effect.as("hello"),
      ),
    translateStream: () => Effect.succeed("unused"),
  })

  const fakeDesktop = DesktopSession.of({
    detect: Effect.succeed("wayland"),
  })

  const fakeTextInjection = TextInjectionBackendService.of({
    backend: "wtype",
    typeText: (text) =>
      Effect.sync(() => {
        typedDeltas.push(text)
      }),
  })

  await Effect.runPromise(
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<Uint8Array, Cause.Done>()
      const fiber = yield* transcribeStreamAndInject({
        operation: "transcribe",
        model: "gpt-realtime-whisper",
        audio: Stream.fromQueue(queue),
        sampleRate: 24_000,
        language: "English",
        promptTemplate: "Transcribe in {{language}}",
        logPrefix: "test",
      }).pipe(Effect.forkChild)

      yield* Queue.offer(queue, new Uint8Array([1, 2]))
      yield* Queue.offer(queue, new Uint8Array([3, 4]))
      yield* Queue.end(queue)
      yield* Fiber.join(fiber)
    }).pipe(
      Effect.provideService(SttService, fakeStt),
      Effect.provideService(DesktopSession, fakeDesktop),
      Effect.provideService(TextInjectionBackendService, fakeTextInjection),
    ),
  )

  assert.deepEqual(receivedChunks, [
    [1, 2],
    [3, 4],
  ])
  assert.deepEqual(typedDeltas, ["hel", "lo"])
})

test("default realtime command paths do not normalize or WAV-wrap STT audio", async () => {
  const files = [
    "src/commands/assistant/pttLoop.ts",
    "src/commands/assistant/wakewordLoop.ts",
    "src/commands/sttInteractive.ts",
  ]

  for (const file of files) {
    const content = await readFile(file, "utf8")
    assert.equal(content.includes("normalizePcmForStt"), false, file)
    assert.equal(content.includes("encodePcm16MonoWav"), false, file)
  }
})
