import { test } from "node:test"
import * as assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { Effect, Fiber, Queue, Stream, type Cause } from "effect"

import { DesktopSession } from "../src/desktop/session.js"
import { TextInjectionBackendService } from "../src/input/textInjection.js"
import { CodexRealtimeSttService } from "../src/stt/codexRealtimeService.js"
import { OpenRouterSttService } from "../src/stt/openrouter.js"
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

test("gpt-realtime-2 translation collects stream before calling Codex", async () => {
  const receivedChunks: Array<Array<number>> = []
  let sawDeltaCallback = false

  const fakeCodex = CodexRealtimeSttService.of({
    transcribe: () => Effect.succeed("unused"),
    translate: (config) =>
      config.audio.pipe(
        Stream.runForEach((chunk) =>
          Effect.sync(() => {
            receivedChunks.push([...chunk])
            sawDeltaCallback = config.onDelta !== undefined
          }),
        ),
        Effect.as("translated"),
      ),
  })

  const fakeOpenRouter = OpenRouterSttService.of({
    transcribe: () => Effect.succeed("unused"),
    translate: () => Effect.succeed("unused"),
  })

  const sttConfig = {
    schemaVersion: 2 as const,
    provider: "codex-realtime" as const,
    transcriptionModel: "gpt-realtime-whisper",
    translationModel: "gpt-realtime-2",
    transcriptionLanguage: "Polish",
    translationSourceLanguage: "Polish",
    translationTargetLanguage: "English",
    wakewordEnabled: false,
    wakewordDictationSilenceSeconds: 3,
    wakewordDictationMaxSeconds: 120,
    wakewordDictationSpeechRmsThreshold: 0.01,
    transcriptionPrompt: "Transcribe in {{language}}",
    translationPrompt: "Translate {{source_language}} to {{target_language}}",
  }

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<Uint8Array, Cause.Done>()
      const stt = yield* SttService
      const fiber = yield* stt
        .translateStream({
          model: "gpt-realtime-2",
          audio: Stream.fromQueue(queue),
          sampleRate: 24_000,
          sourceLanguage: "Polish",
          targetLanguage: "English",
          promptTemplate: "Translate {{source_language}} to {{target_language}}",
          onDelta: () => Effect.sync(() => {}),
        })
        .pipe(Effect.forkChild)

      yield* Queue.offer(queue, new Uint8Array([1, 2]))
      yield* Queue.offer(queue, new Uint8Array([3, 4]))
      yield* Queue.end(queue)
      return yield* Fiber.join(fiber)
    }).pipe(
      Effect.provide(SttService.layerFromConfig(sttConfig)),
      Effect.provideService(CodexRealtimeSttService, fakeCodex),
      Effect.provideService(OpenRouterSttService, fakeOpenRouter),
    ),
  )

  assert.strictEqual(result, "translated")
  assert.deepEqual(receivedChunks, [[1, 2, 3, 4]])
  assert.strictEqual(sawDeltaCallback, false)
})
