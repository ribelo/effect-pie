export type AssistantTraceEvent = {
  readonly timestamp: string
  readonly category: "mode" | "ptt" | "wakeword" | "stt" | "injection"
  readonly message: string
}

export type AssistantState =
  | "idle"
  | "ptt-transcribe"
  | "ptt-translate"
  | "wakeword-dictation"
  | "stt"
  | "injection"

export const isShellTraceEnabled = (envValue: string | undefined): boolean => {
  if (envValue === undefined || envValue.trim().length === 0) {
    return false
  }
  const normalized = envValue.trim().toLowerCase()
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on"
}

export class AssistantDiagnostics {
  private readonly maxEntries: number
  private entries: Array<AssistantTraceEvent> = []
  private currentState: AssistantState = "idle"

  constructor(maxEntries = 50) {
    this.maxEntries = maxEntries
  }

  get state(): AssistantState {
    return this.currentState
  }

  setState(state: AssistantState): void {
    this.currentState = state
    this.push("mode", `state=${state}`)
  }

  pttHold(mode: string): void {
    this.push("ptt", `hold mode=${mode}`)
  }

  pttRelease(): void {
    this.push("ptt", "release")
  }

  pttFinalize(durationMs: number): void {
    this.push("ptt", `finalize durationMs=${durationMs}`)
  }

  wakewordTrigger(modelName: string): void {
    this.push("wakeword", `trigger model=${modelName}`)
  }

  sttStart(model: string): void {
    this.push("stt", `start model=${model}`)
  }

  sttComplete(textLength: number): void {
    this.push("stt", `complete textLength=${textLength}`)
  }

  sttFailure(message: string): void {
    this.push("stt", `failure message=${message}`)
  }

  injectionStart(textLength: number): void {
    this.push("injection", `start textLength=${textLength}`)
  }

  injectionComplete(): void {
    this.push("injection", "complete")
  }

  injectionFailure(message: string): void {
    this.push("injection", `failure message=${message}`)
  }

  renderSnapshot(): string {
    const lines: Array<string> = [
      "=== Assistant Diagnostics Snapshot ===",
      `State: ${this.currentState}`,
      `Trace entries (${this.entries.length}):`,
    ]

    for (const entry of this.entries) {
      lines.push(`  [${entry.category}] ${entry.timestamp} ${entry.message}`)
    }

    lines.push("=====================================")
    return lines.join("\n")
  }

  private push(category: AssistantTraceEvent["category"], message: string): void {
    this.entries.push({
      timestamp: new Date().toISOString(),
      category,
      message,
    })

    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(-this.maxEntries)
    }
  }
}
