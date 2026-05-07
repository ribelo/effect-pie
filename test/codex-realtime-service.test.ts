import * as assert from "node:assert/strict"
import { test } from "node:test"
import type { Cause } from "effect"
import { Effect, Exit, Queue, Stream } from "effect"

import {
  buildCodexRealtimeHeaders,
  CodexRealtimeSttError,
  runCodexRealtimeSession,
  type CodexRealtimeConnection,
} from "../src/stt/codexRealtimeService.js"
import {
  buildTranscriptionSessionUpdate,
  buildTranslationSessionUpdate,
} from "../src/stt/codexRealtime.js"

type FakeConnection = {
  readonly connection: CodexRealtimeConnection
  readonly sent: ReadonlyArray<string>
  readonly pushMessage: (payload: string) => Promise<void>
  readonly closeMessages: () => Promise<void>
}

const makeFakeConnection = async (): Promise<FakeConnection> => {
  const queue = await Effect.runPromise(Queue.unbounded<string, Cause.Done>())
  const sent: Array<string> = []

  const connection: CodexRealtimeConnection = {
    send: (payload) =>
      Effect.sync(() => {
        sent.push(payload)
      }),
    close: Effect.sync(() => {
      Effect.runFork(Queue.end(queue))
    }),
    messages: Stream.fromQueue(queue),
  }

  return {
    connection,
    sent,
    pushMessage: (payload) => Effect.runPromise(Queue.offer(queue, payload)).then(() => undefined),
    closeMessages: () => Effect.runPromise(Queue.end(queue)).then(() => undefined),
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })

const pcm16bytes = (samples: ReadonlyArray<number>): Uint8Array => {
  const bytes = new Uint8Array(samples.length * 2)
  const view = new DataView(bytes.buffer)
  samples.forEach((s, i) => view.setInt16(i * 2, s, true))
  return bytes
}

test("buildCodexRealtimeHeaders uses the GA realtime API by omitting the beta header", () => {
  const headers = buildCodexRealtimeHeaders("token")
  assert.strictEqual(headers["Authorization"], "Bearer token")
  assert.strictEqual("OpenAI-Beta" in headers, false)
})

test("runCodexRealtimeSession sends session.update first, appends audio, then commits", async () => {
  const fake = await makeFakeConnection()
  const audio = Stream.fromIterable([pcm16bytes([1, 2, 3, 4])])

  const sessionPromise = Effect.runPromise(
    runCodexRealtimeSession({
      sessionUpdate: buildTranscriptionSessionUpdate({ model: "gpt-realtime-whisper" }),
      audio,
      inputSampleRate: 24_000,
      connection: fake.connection,
    }),
  )

  await sleep(20)
  await fake.pushMessage(
    JSON.stringify({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "hello",
    }),
  )

  const transcript = await sessionPromise
  assert.strictEqual(transcript, "hello")

  const sentTypes = fake.sent.map((raw) => JSON.parse(raw).type)
  assert.strictEqual(sentTypes[0], "session.update")
  assert.ok(sentTypes.includes("input_audio_buffer.append"))
  assert.strictEqual(sentTypes[sentTypes.length - 1], "input_audio_buffer.commit")
})

test("runCodexRealtimeSession streams delta callbacks and accumulates final text", async () => {
  const fake = await makeFakeConnection()
  const audio = Stream.fromIterable([pcm16bytes([0, 0, 0, 0])])
  const deltas: Array<string> = []

  const sessionPromise = Effect.runPromise(
    runCodexRealtimeSession({
      sessionUpdate: buildTranscriptionSessionUpdate({ model: "gpt-realtime-whisper" }),
      audio,
      inputSampleRate: 24_000,
      onDelta: (delta) =>
        Effect.sync(() => {
          deltas.push(delta)
        }),
      connection: fake.connection,
    }),
  )

  await sleep(10)
  await fake.pushMessage(
    JSON.stringify({
      type: "conversation.item.input_audio_transcription.delta",
      delta: "hello ",
    }),
  )
  await fake.pushMessage(
    JSON.stringify({
      type: "conversation.item.input_audio_transcription.delta",
      delta: "world",
    }),
  )
  await fake.pushMessage(
    JSON.stringify({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "hello world",
    }),
  )

  const result = await sessionPromise
  assert.strictEqual(result, "hello world")
  assert.deepEqual(deltas, ["hello ", "world"])
})

test("runCodexRealtimeSession returns accumulated deltas when no done event arrives", async () => {
  const fake = await makeFakeConnection()
  const audio = Stream.fromIterable([pcm16bytes([0, 0])])

  const sessionPromise = Effect.runPromise(
    runCodexRealtimeSession({
      sessionUpdate: buildTranslationSessionUpdate({ model: "gpt-realtime-translate" }),
      audio,
      inputSampleRate: 24_000,
      connection: fake.connection,
    }),
  )

  await sleep(10)
  await fake.pushMessage(
    JSON.stringify({ type: "conversation.output_transcript.delta", delta: "bon" }),
  )
  await fake.pushMessage(
    JSON.stringify({ type: "conversation.output_transcript.delta", delta: "jour" }),
  )
  await fake.closeMessages()

  const result = await sessionPromise
  assert.strictEqual(result, "bonjour")
})

test("runCodexRealtimeSession uses translation audio buffer event names in translation mode", async () => {
  const fake = await makeFakeConnection()
  const audio = Stream.fromIterable([pcm16bytes([0, 0])])

  const sessionPromise = Effect.runPromise(
    runCodexRealtimeSession({
      sessionUpdate: buildTranslationSessionUpdate({ model: "gpt-realtime-translate" }),
      mode: "translation",
      audio,
      inputSampleRate: 24_000,
      translationOutputDrainMillis: 50,
      connection: fake.connection,
    }),
  )

  await sleep(5)
  await fake.pushMessage(
    JSON.stringify({ type: "conversation.output_transcript.delta", delta: "bonjour" }),
  )

  await sessionPromise
  const sentTypes = fake.sent.map((raw) => JSON.parse(raw).type)
  assert.ok(sentTypes.includes("session.input_audio_buffer.append"))
  assert.strictEqual(sentTypes.includes("input_audio_buffer.commit"), false)
  assert.strictEqual(sentTypes.includes("session.input_audio_buffer.commit"), false)
})

test("runCodexRealtimeSession fails with typed error on server error event", async () => {
  const fake = await makeFakeConnection()
  const audio = Stream.fromIterable([pcm16bytes([0, 0])])

  const sessionPromise = Effect.runPromiseExit(
    runCodexRealtimeSession({
      sessionUpdate: buildTranscriptionSessionUpdate({ model: "gpt-realtime-whisper" }),
      audio,
      inputSampleRate: 24_000,
      connection: fake.connection,
    }),
  )

  await sleep(10)
  await fake.pushMessage(
    JSON.stringify({
      type: "error",
      error: { message: "invalid request", code: "invalid_request_error" },
    }),
  )

  const exit = await sessionPromise
  assert.strictEqual(Exit.isFailure(exit), true)
  if (Exit.isFailure(exit)) {
    const failure = exit.cause.toString()
    assert.match(failure, /invalid request/)
    assert.match(failure, /CodexRealtimeSttError/)
  }
})

test("runCodexRealtimeSession fails when session ends with no transcript text", async () => {
  const fake = await makeFakeConnection()
  const audio = Stream.fromIterable([pcm16bytes([0, 0])])

  const sessionPromise = Effect.runPromiseExit(
    runCodexRealtimeSession({
      sessionUpdate: buildTranscriptionSessionUpdate({ model: "gpt-realtime-whisper" }),
      audio,
      inputSampleRate: 24_000,
      connection: fake.connection,
    }),
  )

  await sleep(10)
  await fake.closeMessages()

  const exit = await sessionPromise
  assert.strictEqual(Exit.isFailure(exit), true)
})

test("CodexRealtimeSttError keeps message concise and doesn't embed tokens", () => {
  const err = new CodexRealtimeSttError({ message: "Codex realtime server error: foo" })
  assert.strictEqual(err.message.includes("Bearer"), false)
  assert.strictEqual(err.message.includes("eyJ"), false)
})
