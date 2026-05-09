import { test } from "node:test"
import * as assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { Effect, Fiber, Queue, Stream, type Cause } from "effect"

import { DesktopSession } from "../src/desktop/session.js"
import { TextInjectionBackendService } from "../src/input/textInjection.js"
import { Niri } from "../src/niri/service.js"
import type { NiriWindow } from "../src/niri/schema.js"
import { CodexRealtimeSttService } from "../src/stt/codexRealtimeService.js"
import { OpenRouterSttService } from "../src/stt/openrouter.js"
import { SttService } from "../src/stt/service.js"
import { transcribeStreamAndInject } from "../src/stt/transcribeAndInject.js"

const sampleNiriWindow: NiriWindow = {
  id: 1,
  title: "Quarterly Planning – Slack",
  app_id: "com.slack.Slack",
  pid: 1234,
  workspace_id: 7,
  is_focused: true,
  is_floating: false,
  is_urgent: false,
  layout: {
    pos_in_scrolling_layout: null,
    tile_size: [1280, 720],
    window_size: [1280, 720],
    tile_pos_in_workspace_view: null,
    window_offset_in_tile: [0, 0],
  },
  focus_timestamp: null,
}

const fakeNiri = (focusedWindow: NiriWindow | null) =>
  Niri.of({
    version: Effect.die("unused"),
    outputs: Effect.die("unused"),
    workspaces: Effect.die("unused"),
    windows: Effect.die("unused"),
    layers: Effect.die("unused"),
    keyboardLayouts: Effect.die("unused"),
    focusedOutput: Effect.die("unused"),
    focusedWindow: Effect.succeed(focusedWindow),
    pickWindow: Effect.die("unused"),
    pickColor: Effect.die("unused"),
    overviewState: Effect.die("unused"),
    runAction: () => Effect.die("unused"),
    configureOutput: () => Effect.die("unused"),
    actions: {
      raw: () => Effect.die("unused"),
      focusWindow: () => Effect.die("unused"),
      closeWindow: () => Effect.die("unused"),
      moveWindowToWorkspace: () => Effect.die("unused"),
      screenshotWindow: () => Effect.die("unused"),
      setWindowWidth: () => Effect.die("unused"),
      setDynamicCastMonitor: () => Effect.die("unused"),
      loadConfigFile: Effect.die("unused"),
    },
    outputsConfig: {
      setScale: () => Effect.die("unused"),
      setMode: () => Effect.die("unused"),
      setCustomMode: () => Effect.die("unused"),
      setModeline: () => Effect.die("unused"),
      setTransform: () => Effect.die("unused"),
      setPosition: () => Effect.die("unused"),
      setVrr: () => Effect.die("unused"),
      off: () => Effect.die("unused"),
      on: () => Effect.die("unused"),
    },
    events: Stream.empty,
  })

const fakeWaylandDesktop = DesktopSession.of({
  detect: Effect.succeed("wayland"),
})

const fakeNoopTextInjection = TextInjectionBackendService.of({
  backend: "wtype",
  typeText: () => Effect.void,
})

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
      Effect.provideService(Niri, fakeNiri(null)),
    ),
  )

  assert.deepEqual(receivedChunks, [
    [1, 2],
    [3, 4],
  ])
  assert.deepEqual(typedDeltas, ["hel", "lo"])
})

test("transcribeStreamAndInject collapses streamed newlines before typing", async () => {
  const typedDeltas: Array<string> = []

  const fakeStt = SttService.of({
    provider: "codex-realtime",
    transcribe: () => Effect.succeed("unused"),
    translate: () => Effect.succeed("unused"),
    transcribeStream: (config) =>
      config.audio.pipe(
        Stream.runForEach(() =>
          Effect.gen(function* () {
            if (config.onDelta !== undefined) {
              yield* config.onDelta("hello\nworld")
            }
          }),
        ),
        Effect.as("hello\nworld"),
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
      yield* Queue.end(queue)
      yield* Fiber.join(fiber)
    }).pipe(
      Effect.provideService(SttService, fakeStt),
      Effect.provideService(DesktopSession, fakeDesktop),
      Effect.provideService(TextInjectionBackendService, fakeTextInjection),
      Effect.provideService(Niri, fakeNiri(null)),
    ),
  )

  assert.deepEqual(typedDeltas, ["hello world"])
})

test("transcribeStreamAndInject adds focused window context to transcription prompts", async () => {
  let receivedPrompt = ""

  const fakeStt = SttService.of({
    provider: "codex-realtime",
    transcribe: () => Effect.succeed("unused"),
    translate: () => Effect.succeed("unused"),
    transcribeStream: (config) =>
      config.audio.pipe(
        Stream.runDrain,
        Effect.tap(() =>
          Effect.sync(() => {
            receivedPrompt = config.promptTemplate
          }),
        ),
        Effect.as("done"),
      ),
    translateStream: () => Effect.succeed("unused"),
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
        promptTemplate: "Transcribe in {{language}}.",
        logPrefix: "test",
        inject: false,
      }).pipe(Effect.forkChild)

      yield* Queue.offer(queue, new Uint8Array([1, 2]))
      yield* Queue.end(queue)
      yield* Fiber.join(fiber)
    }).pipe(
      Effect.provideService(SttService, fakeStt),
      Effect.provideService(DesktopSession, fakeWaylandDesktop),
      Effect.provideService(TextInjectionBackendService, fakeNoopTextInjection),
      Effect.provideService(Niri, fakeNiri(sampleNiriWindow)),
    ),
  )

  assert.match(receivedPrompt, /Transcribe in \{\{language\}\}\./)
  assert.match(receivedPrompt, /Focused window context/)
  assert.match(receivedPrompt, /app_id: com\.slack\.Slack/)
  assert.match(receivedPrompt, /title: Quarterly Planning – Slack/)
  assert.doesNotMatch(receivedPrompt, /pid/)
  assert.doesNotMatch(receivedPrompt, /workspace/)
})

test("transcribeStreamAndInject adds focused window context to translation prompts", async () => {
  let receivedPrompt = ""

  const fakeStt = SttService.of({
    provider: "codex-realtime",
    transcribe: () => Effect.succeed("unused"),
    translate: () => Effect.succeed("unused"),
    transcribeStream: () => Effect.succeed("unused"),
    translateStream: (config) =>
      config.audio.pipe(
        Stream.runDrain,
        Effect.tap(() =>
          Effect.sync(() => {
            receivedPrompt = config.promptTemplate
          }),
        ),
        Effect.as("done"),
      ),
  })

  await Effect.runPromise(
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<Uint8Array, Cause.Done>()
      const fiber = yield* transcribeStreamAndInject({
        operation: "translate",
        model: "gpt-realtime-2",
        audio: Stream.fromQueue(queue),
        sampleRate: 24_000,
        sourceLanguage: "Polish",
        targetLanguage: "English",
        promptTemplate: "Translate {{source_language}} to {{target_language}}.",
        logPrefix: "test",
        inject: false,
      }).pipe(Effect.forkChild)

      yield* Queue.offer(queue, new Uint8Array([1, 2]))
      yield* Queue.end(queue)
      yield* Fiber.join(fiber)
    }).pipe(
      Effect.provideService(SttService, fakeStt),
      Effect.provideService(DesktopSession, fakeWaylandDesktop),
      Effect.provideService(TextInjectionBackendService, fakeNoopTextInjection),
      Effect.provideService(Niri, fakeNiri(sampleNiriWindow)),
    ),
  )

  assert.match(receivedPrompt, /Translate \{\{source_language\}\} to \{\{target_language\}\}\./)
  assert.match(receivedPrompt, /Focused window context/)
  assert.match(receivedPrompt, /app_id: com\.slack\.Slack/)
  assert.match(receivedPrompt, /title: Quarterly Planning – Slack/)
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

test("SttService passes transcription prompts to Codex realtime", async () => {
  let receivedPrompt: unknown

  const fakeCodex = CodexRealtimeSttService.of({
    transcribe: (config) =>
      config.audio.pipe(
        Stream.runDrain,
        Effect.tap(() =>
          Effect.sync(() => {
            receivedPrompt = Reflect.get(config, "promptTemplate")
          }),
        ),
        Effect.as("transcribed"),
      ),
    translate: () => Effect.succeed("unused"),
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

  await Effect.runPromise(
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<Uint8Array, Cause.Done>()
      const stt = yield* SttService
      const fiber = yield* stt
        .transcribeStream({
          model: "gpt-realtime-whisper",
          audio: Stream.fromQueue(queue),
          sampleRate: 24_000,
          language: "Polish",
          promptTemplate: "Transcribe in {{language}}. Focused window context: Slack.",
        })
        .pipe(Effect.forkChild)

      yield* Queue.offer(queue, new Uint8Array([1, 2]))
      yield* Queue.end(queue)
      yield* Fiber.join(fiber)
    }).pipe(
      Effect.provide(SttService.layerFromConfig(sttConfig)),
      Effect.provideService(CodexRealtimeSttService, fakeCodex),
      Effect.provideService(OpenRouterSttService, fakeOpenRouter),
    ),
  )

  assert.strictEqual(receivedPrompt, "Transcribe in {{language}}. Focused window context: Slack.")
})
