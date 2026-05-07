import { Data, Effect, Schema } from "effect"

export const CODEX_REALTIME_SAMPLE_RATE = 24_000

export const CODEX_REALTIME_BASE_URL = "wss://api.openai.com"
export const CODEX_REALTIME_BASE_URL_OVERRIDE_ENV = "CODEX_REALTIME_BASE_URL_OVERRIDE"

export const DEFAULT_CODEX_TRANSCRIPTION_MODEL = "gpt-realtime-whisper"
export const DEFAULT_CODEX_TRANSLATION_MODEL = "gpt-realtime-translate"

export type CodexRealtimeMode = "transcription" | "translation"

export class CodexRealtimeProtocolError extends Data.TaggedError("CodexRealtimeProtocolError")<{
  readonly message: string
  readonly code?: string | undefined
  readonly eventType?: string | undefined
}> {}

export const resolveCodexRealtimeBaseUrl = (env: NodeJS.ProcessEnv = process.env): string => {
  const override = env[CODEX_REALTIME_BASE_URL_OVERRIDE_ENV]?.trim()
  if (override !== undefined && override.length > 0) {
    return override
  }
  return CODEX_REALTIME_BASE_URL
}

export const buildCodexRealtimeUrl = (config: {
  readonly mode: CodexRealtimeMode
  readonly model: string
  readonly baseUrl?: string | undefined
}): string => {
  const base = (config.baseUrl ?? CODEX_REALTIME_BASE_URL).replace(/\/+$/, "")
  const pathPart = config.mode === "transcription" ? "/v1/realtime" : "/v1/realtime/translations"
  const query = new URLSearchParams({ model: config.model })
  return `${base}${pathPart}?${query.toString()}`
}

export const buildTranscriptionSessionUpdate = (config: {
  readonly model: string
}): {
  readonly type: "session.update"
  readonly session: unknown
} => ({
  type: "session.update",
  session: {
    type: "transcription",
    audio: {
      input: {
        format: { type: "audio/pcm", rate: CODEX_REALTIME_SAMPLE_RATE },
        transcription: { model: config.model },
      },
    },
  },
})

export const buildTranslationSessionUpdate = (config: {
  readonly model: string
  readonly targetLanguage?: string | undefined
}): {
  readonly type: "session.update"
  readonly session: unknown
} => ({
  type: "session.update",
  session: {
    type: "translation",
    model: config.model,
    audio: {
      input: {
        format: { type: "audio/pcm", rate: CODEX_REALTIME_SAMPLE_RATE },
      },
      ...(config.targetLanguage !== undefined
        ? {
            output: {
              language: config.targetLanguage,
            },
          }
        : {}),
    },
  },
})

export const buildAudioAppend = (
  pcmBytes: Uint8Array,
  mode: CodexRealtimeMode = "transcription",
): {
  readonly type: "input_audio_buffer.append" | "session.input_audio_buffer.append"
  readonly audio: string
} => ({
  type: mode === "translation" ? "session.input_audio_buffer.append" : "input_audio_buffer.append",
  audio: Buffer.from(pcmBytes).toString("base64"),
})

export const AUDIO_BUFFER_COMMIT = { type: "input_audio_buffer.commit" } as const

export const buildAudioCommit = (
  mode: CodexRealtimeMode = "transcription",
): {
  readonly type: "input_audio_buffer.commit" | "session.input_audio_buffer.commit"
} => ({
  type: mode === "translation" ? "session.input_audio_buffer.commit" : "input_audio_buffer.commit",
})

export type CodexRealtimeEvent =
  | { readonly kind: "session"; readonly eventType: string }
  | { readonly kind: "transcriptDelta"; readonly delta: string }
  | { readonly kind: "transcriptDone"; readonly transcript: string }
  | { readonly kind: "error"; readonly message: string; readonly code?: string | undefined }
  | { readonly kind: "other"; readonly eventType: string }

const SessionEventSchema = Schema.Struct({
  type: Schema.String,
})

const DeltaEventSchema = Schema.Struct({
  type: Schema.String,
  delta: Schema.String,
})

const TranscriptDoneSchema = Schema.Struct({
  type: Schema.String,
  transcript: Schema.String,
})

const ErrorEventSchema = Schema.Struct({
  type: Schema.Literal("error"),
  error: Schema.optional(
    Schema.Struct({
      message: Schema.optional(Schema.NullOr(Schema.String)),
      code: Schema.optional(Schema.NullOr(Schema.String)),
      type: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
  message: Schema.optional(Schema.NullOr(Schema.String)),
})

const TRANSCRIPT_DELTA_TYPES = new Set<string>([
  "conversation.item.input_audio_transcription.delta",
  "conversation.input_transcript.delta",
  "conversation.output_transcript.delta",
  "response.output_text.delta",
  "response.output_audio_transcript.delta",
])

const TRANSCRIPT_DONE_TYPES = new Set<string>([
  "conversation.item.input_audio_transcription.completed",
  "response.output_audio_transcript.done",
  "conversation.output_transcript.done",
])

const SESSION_EVENT_TYPES = new Set<string>([
  "session.created",
  "session.updated",
  "transcription_session.created",
  "transcription_session.updated",
])

export const parseCodexRealtimeEvent = (
  payload: string,
): Effect.Effect<CodexRealtimeEvent, CodexRealtimeProtocolError> =>
  Effect.gen(function* () {
    const json = yield* Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(payload).pipe(
      Effect.mapError(
        () =>
          new CodexRealtimeProtocolError({
            message: "Codex realtime event is not valid JSON",
          }),
      ),
    )

    const head = yield* Schema.decodeUnknownEffect(SessionEventSchema)(json).pipe(
      Effect.mapError(
        () =>
          new CodexRealtimeProtocolError({
            message: "Codex realtime event missing 'type' field",
          }),
      ),
    )

    const eventType = head.type

    if (eventType === "error") {
      const err = yield* Schema.decodeUnknownEffect(ErrorEventSchema)(json).pipe(
        Effect.mapError(
          () =>
            new CodexRealtimeProtocolError({
              message: "Codex realtime error event could not be parsed",
              eventType,
            }),
        ),
      )
      const message =
        err.error?.message ?? err.message ?? "Codex realtime server returned an unspecified error"
      return {
        kind: "error" as const,
        message,
        ...(err.error?.code !== undefined && err.error.code !== null
          ? { code: err.error.code }
          : {}),
      }
    }

    if (TRANSCRIPT_DELTA_TYPES.has(eventType)) {
      const delta = yield* Schema.decodeUnknownEffect(DeltaEventSchema)(json).pipe(
        Effect.mapError(
          () =>
            new CodexRealtimeProtocolError({
              message: "Codex realtime delta event missing 'delta' string field",
              eventType,
            }),
        ),
      )
      return { kind: "transcriptDelta" as const, delta: delta.delta }
    }

    if (TRANSCRIPT_DONE_TYPES.has(eventType)) {
      const done = yield* Schema.decodeUnknownEffect(TranscriptDoneSchema)(json).pipe(
        Effect.mapError(
          () =>
            new CodexRealtimeProtocolError({
              message: "Codex realtime done event missing 'transcript' field",
              eventType,
            }),
        ),
      )
      return { kind: "transcriptDone" as const, transcript: done.transcript }
    }

    if (SESSION_EVENT_TYPES.has(eventType)) {
      return { kind: "session" as const, eventType }
    }

    return { kind: "other" as const, eventType }
  })

export const resampleS16lePcm = (
  inputBytes: Uint8Array,
  inputSampleRate: number,
  outputSampleRate: number,
): Uint8Array => {
  if (inputSampleRate === outputSampleRate) {
    return inputBytes
  }

  const inputSamples = Math.floor(inputBytes.length / 2)
  if (inputSamples === 0) {
    return new Uint8Array(0)
  }

  const inputView = new DataView(inputBytes.buffer, inputBytes.byteOffset, inputSamples * 2)
  const outputSamples = Math.max(1, Math.round((inputSamples * outputSampleRate) / inputSampleRate))
  const outputBytes = new Uint8Array(outputSamples * 2)
  const outputView = new DataView(outputBytes.buffer)

  const ratio = (inputSamples - 1) / Math.max(1, outputSamples - 1)

  for (let outIndex = 0; outIndex < outputSamples; outIndex += 1) {
    const srcPos = outIndex * ratio
    const srcIndex = Math.floor(srcPos)
    const frac = srcPos - srcIndex
    const s0 = inputView.getInt16(srcIndex * 2, true)
    const s1 = srcIndex + 1 < inputSamples ? inputView.getInt16((srcIndex + 1) * 2, true) : s0
    const interpolated = Math.round(s0 + (s1 - s0) * frac)
    const clamped = Math.max(-32768, Math.min(32767, interpolated))
    outputView.setInt16(outIndex * 2, clamped, true)
  }

  return outputBytes
}
