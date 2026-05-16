import { test } from "node:test"
import * as assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { Effect, Layer, Queue, Stream } from "effect"

import { RecordingCoordinator } from "../src/commands/assistant/coordinator.js"
import {
  MeetingTranscriptionController,
  resolveMeetingMonitorSource,
} from "../src/commands/assistant/meetingTranscription.js"
import type { SttRuntimeConfig } from "../src/stt/config.js"
import { SttService } from "../src/stt/service.js"
import { PulseAudioClient } from "../src/pulse/client.js"
import { PA_NO_INDEX, PA_SAMPLE_FORMAT, type SourceInfo } from "../src/pulse/defs.js"

const source = (config: {
  readonly name: string
  readonly description?: string
  readonly monitorName?: string | null
}): SourceInfo => ({
  index: 1,
  name: config.name,
  description: config.description ?? config.name,
  sampleSpec: { format: PA_SAMPLE_FORMAT.S16LE, channels: 2, rate: 48_000 },
  channelMap: [1, 2],
  monitorIndex: PA_NO_INDEX,
  monitorName: config.monitorName ?? null,
  latencyUsec: 0n,
  driver: null,
  flags: 0,
})

const sttConfig: SttRuntimeConfig = {
  schemaVersion: 2,
  provider: "codex-realtime",
  transcriptionModel: "test-transcribe",
  translationModel: "test-translate",
  transcriptionLanguage: "en",
  translationSourceLanguage: "pl",
  translationTargetLanguage: "en",
  wakewordEnabled: false,
  wakewordDictationSilenceSeconds: 1,
  wakewordDictationMaxSeconds: 10,
  wakewordDictationSpeechRmsThreshold: 0.01,
  transcriptionPrompt: "transcribe",
  translationPrompt: "translate",
}

test("resolveMeetingMonitorSource prefers the default sink monitor", () => {
  const resolved = resolveMeetingMonitorSource({
    defaultSink: "alsa_output.default",
    sources: [
      source({ name: "alsa_input.microphone" }),
      source({ name: "alsa_output.other.monitor", monitorName: "alsa_output.other" }),
      source({ name: "alsa_output.default.monitor", monitorName: "alsa_output.default" }),
    ],
  })

  assert.strictEqual(resolved.name, "alsa_output.default.monitor")
})

test("meeting transcription captures monitor audio, writes transcript, and clears state on stop", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pie-meeting-test-"))
  const persistPath = path.join(tmpDir, "recording.json")
  const audioQueue = Effect.runSync(Queue.unbounded<Uint8Array>())
  const selectedSources: Array<string | null> = []

  const pulseLayer = Layer.succeed(
    PulseAudioClient,
    PulseAudioClient.of({
      getServerInfo: Effect.succeed({
        name: "test",
        version: "test",
        username: "test",
        hostname: "test",
        sampleSpec: { format: PA_SAMPLE_FORMAT.S16LE, channels: 2, rate: 48_000 },
        defaultSink: "alsa_output.default",
        defaultSource: "alsa_input.microphone",
        cookie: 1,
        defaultChannelMap: [1, 2],
      }),
      listSources: Effect.succeed([
        source({ name: "alsa_input.microphone" }),
        source({ name: "alsa_output.default.monitor", monitorName: "alsa_output.default" }),
      ]),
      openRecordStream: () => Effect.die("not used"),
      closeRecordStream: () => Effect.void,
      acquireRecordStream: (options) =>
        Effect.sync(() => {
          selectedSources.push(options?.sourceName ?? null)
          return {
            info: {
              streamIndex: 1,
              sourceOutputIndex: 1,
              maximumLength: 0,
              fragmentSize: options?.fragmentSize ?? 0,
              sampleSpec: options?.sampleSpec ?? {
                format: PA_SAMPLE_FORMAT.S16LE,
                channels: 1,
                rate: 24_000,
              },
              channelMap: [1],
              sourceIndex: PA_NO_INDEX,
              sourceName: options?.sourceName ?? null,
              sourceSuspended: false,
              configuredSourceLatencyUsec: 0n,
            },
            queue: audioQueue,
          }
        }),
    }),
  )

  const sttLayer = Layer.succeed(
    SttService,
    SttService.of({
      translateStream: () => Effect.die("not used"),
      transcribeStream: (config) =>
        Stream.runForEach(config.audio, () => config.onDelta?.("hello ") ?? Effect.void).pipe(
          Effect.as(""),
        ),
    }),
  )

  const program = Effect.scoped(
    Effect.gen(function* () {
      const controller = yield* MeetingTranscriptionController
      const coordinator = yield* RecordingCoordinator

      const start = yield* controller.start
      assert.strictEqual(Reflect.get(start.result, "_tag"), "Started")
      assert.strictEqual(start.snapshot.mode, "meeting-transcribe")
      assert.ok(start.snapshot.transcriptPath?.startsWith(tmpDir))
      yield* Effect.sleep(20)
      assert.deepStrictEqual(selectedSources, ["alsa_output.default.monitor"])

      yield* Queue.offer(audioQueue, new Uint8Array([1, 2, 3]))
      yield* Effect.sleep(20)

      const stopped = yield* controller.stop
      assert.strictEqual(stopped.mode, "idle")

      const transcript = yield* Effect.promise(() =>
        fs.readFile(start.snapshot.transcriptPath!, "utf8"),
      )
      assert.strictEqual(transcript, "hello ")

      const persistedRaw = yield* Effect.promise(() => fs.readFile(persistPath, "utf8"))
      const persisted = JSON.parse(persistedRaw) as Record<string, unknown>
      assert.strictEqual(persisted["mode"], "idle")

      const snapshot = yield* coordinator.snapshot
      assert.strictEqual(snapshot.active, false)
    }),
  ).pipe(
    Effect.provide(
      MeetingTranscriptionController.live({ sttConfig, transcriptDir: tmpDir }).pipe(
        Layer.provideMerge(
          Layer.mergeAll(RecordingCoordinator.live({ persistPath }), pulseLayer, sttLayer),
        ),
      ),
    ),
  )

  await Effect.runPromise(program)
})
