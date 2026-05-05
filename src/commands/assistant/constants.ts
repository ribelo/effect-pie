export const DEFAULT_ASSISTANT_WAKEWORD_MODEL_FILE = "ok_pie.json"
export const DEFAULT_ASSISTANT_PTT_TRANSCRIBE_KEYSYM = 65478
export const DEFAULT_ASSISTANT_PTT_TRANSLATE_KEYSYM = 65479
export const DEFAULT_ASSISTANT_SAMPLE_RATE = 16_000
export const DEFAULT_ASSISTANT_WAKEWORD_FRAGMENT_SIZE = 1024
export const DEFAULT_ASSISTANT_PTT_FRAGMENT_SIZE = 4096
export const DEFAULT_ASSISTANT_MIN_DURATION_MS = 120
export const DEFAULT_ASSISTANT_WAKEWORD_SPEECH_START_TIMEOUT_SECONDS = 8

export const resolveWakewordSpeechStartTimeoutSeconds = (config: {
  readonly silenceSeconds: number
  readonly maxSeconds: number
}): number =>
  Math.min(
    config.maxSeconds,
    Math.max(DEFAULT_ASSISTANT_WAKEWORD_SPEECH_START_TIMEOUT_SECONDS, config.silenceSeconds + 2),
  )
