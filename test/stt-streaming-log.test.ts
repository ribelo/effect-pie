import { test } from "node:test"
import * as assert from "node:assert/strict"
import { Effect, Stream } from "effect"
import { transcribeStreamAndInject } from "../src/stt/transcribeAndInject.js"
import { SttService } from "../src/stt/service.js"
import { TextInjectionBackendService } from "../src/input/textInjection.js"
import { DesktopSession } from "../src/desktop/session.js"
import { Niri } from "../src/niri/niri.js"

test("transcribeStreamAndInject returns undefined on streaming completion", async () => {
  const mockStt = SttService.of({
    transcribeStream: ({ onDelta }) =>
      Effect.gen(function* () {
        if (onDelta) {
          yield* onDelta("hello world")
        }
        return "hello world"
      }),
    translateStream: () => Effect.succeed(""),
  })

  const mockBackend = TextInjectionBackendService.of({
    backend: "wtype",
    typeText: () => Effect.void,
  })

  const mockSession = DesktopSession.of({
    detect: Effect.succeed("wayland" as const),
  })

  const mockNiri = Niri.of({
    version: Effect.succeed({ major: 0, minor: 1, patch: 0, name: "test" }),
    outputs: Effect.succeed({}),
    workspaces: Effect.succeed([]),
    windows: Effect.succeed([]),
    layers: Effect.succeed([]),
    keyboardLayouts: Effect.succeed({ layoutNames: [], keymapName: "" }),
    focusedOutput: Effect.succeed(null),
    focusedWindow: Effect.succeed(null),
    pickWindow: Effect.succeed(null),
    pickColor: Effect.succeed({ r: 0, g: 0, b: 0 }),
    overviewState: Effect.succeed({ isOpen: false }),
    runAction: () => Effect.void,
    configureOutput: () => Effect.succeed({ changed: true, description: "test" }),
    actions: {
      raw: () => Effect.void,
      focusWindow: () => Effect.void,
      closeWindow: () => Effect.void,
      moveWindowToWorkspace: () => Effect.void,
      screenshotWindow: () => Effect.succeed(""),
    },
    eventStream: () => Stream.empty,
  } as any)

  const result = await Effect.runPromise(
    transcribeStreamAndInject({
      operation: "transcribe",
      model: "test",
      audio: Stream.empty,
      sampleRate: 16000,
      language: "en",
      promptTemplate: "test",
      logPrefix: "test",
      inject: true,
    }).pipe(
      Effect.provideService(SttService, mockStt),
      Effect.provideService(TextInjectionBackendService, mockBackend),
      Effect.provideService(DesktopSession, mockSession),
      Effect.provideService(Niri, mockNiri),
    ),
  )

  assert.strictEqual(result, undefined)
})
