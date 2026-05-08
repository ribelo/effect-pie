import * as assert from "node:assert/strict"
import { test } from "node:test"
import { Effect, Exit } from "effect"

import {
  buildAudioAppend,
  buildCodexRealtimeUrl,
  buildConversationTranslationResponseCreate,
  buildConversationTranslationSessionUpdate,
  buildTranscriptionSessionUpdate,
  buildTranslationSessionUpdate,
  CODEX_REALTIME_SAMPLE_RATE,
  parseCodexRealtimeEvent,
  resampleS16lePcm,
  resolveCodexRealtimeBaseUrl,
} from "../src/stt/codexRealtime.js"

test("buildCodexRealtimeUrl targets /v1/realtime for transcription", () => {
  const url = buildCodexRealtimeUrl({ mode: "transcription", model: "gpt-realtime-whisper" })
  assert.strictEqual(url, "wss://api.openai.com/v1/realtime?model=gpt-realtime-whisper")
})

test("buildCodexRealtimeUrl targets /v1/realtime/translations for translation", () => {
  const url = buildCodexRealtimeUrl({ mode: "translation", model: "gpt-realtime-translate" })
  assert.strictEqual(
    url,
    "wss://api.openai.com/v1/realtime/translations?model=gpt-realtime-translate",
  )
})

test("buildCodexRealtimeUrl targets /v1/realtime for conversation", () => {
  const url = buildCodexRealtimeUrl({ mode: "conversation", model: "gpt-realtime-2" })
  assert.strictEqual(url, "wss://api.openai.com/v1/realtime?model=gpt-realtime-2")
})

test("buildCodexRealtimeUrl supports custom base url override", () => {
  const url = buildCodexRealtimeUrl({
    mode: "transcription",
    model: "m",
    baseUrl: "wss://example.test/",
  })
  assert.strictEqual(url, "wss://example.test/v1/realtime?model=m")
})

test("resolveCodexRealtimeBaseUrl returns production default when no override", () => {
  assert.strictEqual(resolveCodexRealtimeBaseUrl({}), "wss://api.openai.com")
})

test("resolveCodexRealtimeBaseUrl honors CODEX_REALTIME_BASE_URL_OVERRIDE", () => {
  assert.strictEqual(
    resolveCodexRealtimeBaseUrl({ CODEX_REALTIME_BASE_URL_OVERRIDE: "wss://mock.test" }),
    "wss://mock.test",
  )
})

test("buildTranscriptionSessionUpdate selects gpt-realtime-whisper and 24 kHz audio/pcm", () => {
  const payload = buildTranscriptionSessionUpdate({ model: "gpt-realtime-whisper" })
  assert.deepEqual(payload, {
    type: "session.update",
    session: {
      type: "transcription",
      audio: {
        input: {
          format: { type: "audio/pcm", rate: CODEX_REALTIME_SAMPLE_RATE },
          transcription: { model: "gpt-realtime-whisper" },
        },
      },
    },
  })
})

test("buildTranslationSessionUpdate uses GA translation session payload", () => {
  const payload = buildTranslationSessionUpdate({
    model: "gpt-realtime-translate",
    targetLanguage: "en",
  })
  assert.deepEqual(payload, {
    type: "session.update",
    session: {
      audio: {
        output: { language: "en" },
      },
    },
  })
})

test("buildTranslationSessionUpdate omits unsupported translation session fields", () => {
  const payload = buildTranslationSessionUpdate({ model: "gpt-realtime-translate" })
  assert.deepEqual(payload, {
    type: "session.update",
    session: {},
  })
})

test("buildConversationTranslationSessionUpdate configures text-only realtime session", () => {
  const payload = buildConversationTranslationSessionUpdate({
    model: "gpt-realtime-2",
    prompt: "Translate Polish to English.",
  })
  assert.deepEqual(payload, {
    type: "session.update",
    session: {
      type: "realtime",
      model: "gpt-realtime-2",
      output_modalities: ["text"],
      instructions: "Translate Polish to English.",
      audio: {
        input: {
          format: { type: "audio/pcm", rate: CODEX_REALTIME_SAMPLE_RATE },
          turn_detection: null,
        },
      },
    },
  })
})

test("buildConversationTranslationResponseCreate requests text output", () => {
  const payload = buildConversationTranslationResponseCreate({
    prompt: "Translate Polish to English.",
  })
  assert.deepEqual(payload, {
    type: "response.create",
    response: {
      output_modalities: ["text"],
      instructions: "Translate Polish to English.",
    },
  })
})

test("buildAudioAppend emits input_audio_buffer.append with base64 audio", () => {
  const pcm = new Uint8Array([0x01, 0x00, 0xff, 0x7f])
  const payload = buildAudioAppend(pcm)
  assert.strictEqual(payload.type, "input_audio_buffer.append")
  assert.strictEqual(payload.audio, Buffer.from(pcm).toString("base64"))
})

test("buildAudioAppend emits session.input_audio_buffer.append for translation", () => {
  const pcm = new Uint8Array([0x01, 0x00, 0xff, 0x7f])
  const payload = buildAudioAppend(pcm, "translation")
  assert.strictEqual(payload.type, "session.input_audio_buffer.append")
  assert.strictEqual(payload.audio, Buffer.from(pcm).toString("base64"))
})

test("parseCodexRealtimeEvent handles input audio transcription delta", async () => {
  const parsed = await Effect.runPromise(
    parseCodexRealtimeEvent(
      JSON.stringify({
        type: "conversation.item.input_audio_transcription.delta",
        delta: "hello",
      }),
    ),
  )
  assert.deepEqual(parsed, { kind: "transcriptDelta", delta: "hello" })
})

test("parseCodexRealtimeEvent handles output_transcript.delta for translations", async () => {
  const parsed = await Effect.runPromise(
    parseCodexRealtimeEvent(
      JSON.stringify({ type: "conversation.output_transcript.delta", delta: "bonjour" }),
    ),
  )
  assert.deepEqual(parsed, { kind: "transcriptDelta", delta: "bonjour" })
})

test("parseCodexRealtimeEvent handles session output transcript deltas for translations", async () => {
  const parsed = await Effect.runPromise(
    parseCodexRealtimeEvent(
      JSON.stringify({ type: "session.output_transcript.delta", delta: "bonjour" }),
    ),
  )
  assert.deepEqual(parsed, { kind: "transcriptDelta", delta: "bonjour" })
})

test("parseCodexRealtimeEvent handles transcription.completed", async () => {
  const parsed = await Effect.runPromise(
    parseCodexRealtimeEvent(
      JSON.stringify({
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "hello world",
      }),
    ),
  )
  assert.deepEqual(parsed, { kind: "transcriptDone", transcript: "hello world" })
})

test("parseCodexRealtimeEvent handles response output text done", async () => {
  const parsed = await Effect.runPromise(
    parseCodexRealtimeEvent(
      JSON.stringify({
        type: "response.output_text.done",
        text: "hello world",
      }),
    ),
  )
  assert.deepEqual(parsed, { kind: "transcriptDone", transcript: "hello world" })
})

test("parseCodexRealtimeEvent handles response.done", async () => {
  const parsed = await Effect.runPromise(
    parseCodexRealtimeEvent(JSON.stringify({ type: "response.done" })),
  )
  assert.deepEqual(parsed, { kind: "responseDone" })
})

test("parseCodexRealtimeEvent parses server error events with message", async () => {
  const parsed = await Effect.runPromise(
    parseCodexRealtimeEvent(
      JSON.stringify({
        type: "error",
        error: { message: "invalid audio format", code: "invalid_request_error" },
      }),
    ),
  )
  assert.deepEqual(parsed, {
    kind: "error",
    message: "invalid audio format",
    code: "invalid_request_error",
  })
})

test("parseCodexRealtimeEvent parses server error events with nullable metadata", async () => {
  const parsed = await Effect.runPromise(
    parseCodexRealtimeEvent(
      JSON.stringify({
        type: "error",
        event_id: "event_123",
        error: {
          type: "invalid_request_error",
          code: null,
          message: "Invalid translation session",
          param: "session.type",
          event_id: null,
        },
      }),
    ),
  )
  assert.deepEqual(parsed, {
    kind: "error",
    message: "Invalid translation session",
  })
})

test("parseCodexRealtimeEvent classifies session.created as session event", async () => {
  const parsed = await Effect.runPromise(
    parseCodexRealtimeEvent(JSON.stringify({ type: "session.created", session: {} })),
  )
  assert.deepEqual(parsed, { kind: "session", eventType: "session.created" })
})

test("parseCodexRealtimeEvent classifies unknown event types as 'other'", async () => {
  const parsed = await Effect.runPromise(
    parseCodexRealtimeEvent(JSON.stringify({ type: "rate_limits.updated", foo: "bar" })),
  )
  assert.deepEqual(parsed, { kind: "other", eventType: "rate_limits.updated" })
})

test("parseCodexRealtimeEvent fails on malformed JSON", async () => {
  const exit = await Effect.runPromiseExit(parseCodexRealtimeEvent("not json"))
  assert.strictEqual(Exit.isFailure(exit), true)
})

test("resampleS16lePcm passes through identical rates", () => {
  const pcm = new Uint8Array([1, 0, 2, 0])
  assert.strictEqual(resampleS16lePcm(pcm, 24_000, 24_000), pcm)
})

test("resampleS16lePcm upsamples 16 kHz -> 24 kHz to a larger buffer", () => {
  const samples = new Int16Array(160)
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = Math.round(10_000 * Math.sin((i / samples.length) * Math.PI))
  }
  const pcm = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength)
  const resampled = resampleS16lePcm(pcm, 16_000, 24_000)
  const outSampleCount = resampled.length / 2
  assert.ok(
    outSampleCount === Math.round((samples.length * 24_000) / 16_000),
    `expected ~${Math.round((samples.length * 24_000) / 16_000)} samples, got ${outSampleCount}`,
  )
})

test("resampleS16lePcm handles empty buffers without throwing", () => {
  const out = resampleS16lePcm(new Uint8Array(0), 16_000, 24_000)
  assert.strictEqual(out.length, 0)
})
