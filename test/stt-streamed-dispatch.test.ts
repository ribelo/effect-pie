import { test } from "node:test"
import * as assert from "node:assert/strict"
import { Effect, Stream } from "effect"

import { DesktopSession } from "../src/desktop/session.js"
import { TextInjectionBackendService, TextInjectionError } from "../src/input/textInjection.js"
import { Niri } from "../src/niri/niri.js"
import { NiriIpcError } from "../src/niri/errors.js"
import { CodexRealtimeSttError } from "../src/stt/codexRealtimeService.js"
import { OpenRouterSttError } from "../src/stt/openrouter.js"
import { CodexAuthError } from "../src/stt/codexAuth.js"
import { SttService } from "../src/stt/service.js"
import { classifyStreamingError, makeStreamedSttDispatch } from "../src/stt/streamedDispatch.js"
import { isSttServiceFailure } from "../src/stt/streamingError.js"

const fakeNiri = Niri.of({
  version: Effect.die("unused"),
  outputs: Effect.die("unused"),
  workspaces: Effect.die("unused"),
  windows: Effect.die("unused"),
  layers: Effect.die("unused"),
  keyboardLayouts: Effect.die("unused"),
  focusedOutput: Effect.die("unused"),
  focusedWindow: Effect.succeed(null),
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

const fakeDesktop = DesktopSession.of({
  detect: Effect.succeed("wayland"),
})

const fakeNoopTextInjection = TextInjectionBackendService.of({
  backend: "wtype",
  typeText: () => Effect.void,
})

test("makeStreamedSttDispatch offer/finish happy path", async () => {
  const receivedChunks: Array<Array<number>> = []

  const fakeStt = SttService.of({
    transcribe: () => Effect.succeed("unused"),
    translate: () => Effect.succeed("unused"),
    transcribeStream: (config) =>
      config.audio.pipe(
        Stream.runForEach((chunk) =>
          Effect.sync(() => {
            receivedChunks.push([...chunk])
          }),
        ),
        Effect.as("hello"),
      ),
    translateStream: () => Effect.succeed("unused"),
  })

  await Effect.runPromise(
    Effect.gen(function* () {
      const dispatch = yield* makeStreamedSttDispatch({
        operation: {
          kind: "transcribe",
          model: "gpt-realtime-whisper",
          language: "English",
          promptTemplate: "Transcribe in {{language}}",
        },
        sampleRate: 24_000,
        logPrefix: "test",
      })

      yield* dispatch.offer(new Uint8Array([1, 2]))
      yield* dispatch.offer(new Uint8Array([3, 4]))
      yield* dispatch.finish
    }).pipe(
      Effect.provideService(SttService, fakeStt),
      Effect.provideService(DesktopSession, fakeDesktop),
      Effect.provideService(TextInjectionBackendService, fakeNoopTextInjection),
      Effect.provideService(Niri, fakeNiri),
    ),
  )

  assert.deepEqual(receivedChunks, [
    [1, 2],
    [3, 4],
  ])
})

test("makeStreamedSttDispatch offer/cancel interrupts fiber without error", async () => {
  const fakeStt = SttService.of({
    transcribe: () => Effect.succeed("unused"),
    translate: () => Effect.succeed("unused"),
    transcribeStream: () => Effect.succeed("unused"),
    translateStream: () => Effect.succeed("unused"),
  })

  await Effect.runPromise(
    Effect.gen(function* () {
      const dispatch = yield* makeStreamedSttDispatch({
        operation: {
          kind: "transcribe",
          model: "gpt-realtime-whisper",
          language: "English",
          promptTemplate: "Transcribe in {{language}}",
        },
        sampleRate: 24_000,
        logPrefix: "test",
      })

      yield* dispatch.offer(new Uint8Array([1, 2]))
      yield* dispatch.cancel
    }).pipe(
      Effect.provideService(SttService, fakeStt),
      Effect.provideService(DesktopSession, fakeDesktop),
      Effect.provideService(TextInjectionBackendService, fakeNoopTextInjection),
      Effect.provideService(Niri, fakeNiri),
    ),
  )
})

test("makeStreamedSttDispatch STT failure surfaces via finish", async () => {
  const fakeStt = SttService.of({
    transcribe: () => Effect.succeed("unused"),
    translate: () => Effect.succeed("unused"),
    transcribeStream: () =>
      Effect.fail(
        new CodexRealtimeSttError({ message: "Realtime connection closed unexpectedly" }),
      ),
    translateStream: () => Effect.succeed("unused"),
  })

  const error = await Effect.runPromise(
    Effect.gen(function* () {
      const dispatch = yield* makeStreamedSttDispatch({
        operation: {
          kind: "transcribe",
          model: "gpt-realtime-whisper",
          language: "English",
          promptTemplate: "Transcribe in {{language}}",
        },
        sampleRate: 24_000,
        logPrefix: "test",
      })

      yield* dispatch.offer(new Uint8Array([1, 2]))
      return yield* dispatch.finish.pipe(Effect.flip)
    }).pipe(
      Effect.provideService(SttService, fakeStt),
      Effect.provideService(DesktopSession, fakeDesktop),
      Effect.provideService(TextInjectionBackendService, fakeNoopTextInjection),
      Effect.provideService(Niri, fakeNiri),
    ),
  )

  assert.ok(error instanceof CodexRealtimeSttError)
  assert.equal(error.message, "Realtime connection closed unexpectedly")

  const classified = classifyStreamingError(error, "Streamed transcription failed")
  assert.equal(classified.kind, "stt")
  assert.equal(
    classified.message,
    "Streamed transcription failed: Realtime connection closed unexpectedly",
  )
})

test("makeStreamedSttDispatch injection-delta failure surfaces via finish", async () => {
  const fakeStt = SttService.of({
    transcribe: () => Effect.succeed("unused"),
    translate: () => Effect.succeed("unused"),
    transcribeStream: (config) =>
      Effect.gen(function* () {
        if (config.onDelta !== undefined) {
          yield* config.onDelta("hello")
        }
        return "hello"
      }),
    translateStream: () => Effect.succeed("unused"),
  })

  const fakeTextInjection = TextInjectionBackendService.of({
    backend: "wtype",
    typeText: () => Effect.fail(new TextInjectionError({ message: "wtype text injection failed" })),
  })

  const error = await Effect.runPromise(
    Effect.gen(function* () {
      const dispatch = yield* makeStreamedSttDispatch({
        operation: {
          kind: "transcribe",
          model: "gpt-realtime-whisper",
          language: "English",
          promptTemplate: "Transcribe in {{language}}",
        },
        sampleRate: 24_000,
        logPrefix: "test",
      })

      yield* dispatch.offer(new Uint8Array([1, 2]))
      return yield* dispatch.finish.pipe(Effect.flip)
    }).pipe(
      Effect.provideService(SttService, fakeStt),
      Effect.provideService(DesktopSession, fakeDesktop),
      Effect.provideService(TextInjectionBackendService, fakeTextInjection),
      Effect.provideService(Niri, fakeNiri),
    ),
  )

  assert.ok(error instanceof TextInjectionError)
  assert.equal(error.message, "wtype text injection failed")

  const classified = classifyStreamingError(error, "Streamed transcription failed")
  assert.equal(classified.kind, "injection")
  assert.equal(classified.message, "Failed to inject streamed text: wtype text injection failed")
})

test("classifyStreamingError branches for all known tags", () => {
  const sttErrors = [
    new OpenRouterSttError({ message: "openrouter" }),
    new CodexRealtimeSttError({ message: "codex" }),
    new CodexAuthError({ message: "auth" }),
    new NiriIpcError({ message: "niri" }),
  ]

  for (const err of sttErrors) {
    const result = classifyStreamingError(err, "prefix")
    assert.equal(result.kind, "stt", `expected stt for ${Reflect.get(err, "_tag")}`)
    assert.match(result.message, /^prefix: /)
  }

  const unknownError: { readonly _tag?: string; readonly message: string } = {
    _tag: "UnknownError",
    message: "unknown",
  }

  const injectionErrors = [new TextInjectionError({ message: "injection" }), unknownError]

  for (const err of injectionErrors) {
    const result = classifyStreamingError(err, "prefix")
    assert.equal(
      result.kind,
      "injection",
      `expected injection for ${Reflect.get(err, "_tag") ?? "no-tag"}`,
    )
    assert.match(result.message, /^Failed to inject streamed text: /)
  }
})

test("isSttServiceFailure matches expected tags", () => {
  assert.equal(isSttServiceFailure(new OpenRouterSttError({ message: "" })), true)
  assert.equal(isSttServiceFailure(new CodexRealtimeSttError({ message: "" })), true)
  assert.equal(isSttServiceFailure(new CodexAuthError({ message: "" })), true)
  assert.equal(isSttServiceFailure(new NiriIpcError({ message: "" })), true)
  assert.equal(isSttServiceFailure(new TextInjectionError({ message: "" })), false)
  assert.equal(isSttServiceFailure({} as { readonly _tag?: string }), false)
})

test("makeStreamedSttDispatch cancel without offer does not error", async () => {
  const fakeStt = SttService.of({
    transcribe: () => Effect.succeed("unused"),
    translate: () => Effect.succeed("unused"),
    transcribeStream: () => Effect.succeed("unused"),
    translateStream: () => Effect.succeed("unused"),
  })

  await Effect.runPromise(
    Effect.gen(function* () {
      const dispatch = yield* makeStreamedSttDispatch({
        operation: {
          kind: "transcribe",
          model: "gpt-realtime-whisper",
          language: "English",
          promptTemplate: "Transcribe in {{language}}",
        },
        sampleRate: 24_000,
        logPrefix: "test",
      })

      yield* dispatch.cancel
    }).pipe(
      Effect.provideService(SttService, fakeStt),
      Effect.provideService(DesktopSession, fakeDesktop),
      Effect.provideService(TextInjectionBackendService, fakeNoopTextInjection),
      Effect.provideService(Niri, fakeNiri),
    ),
  )
})
