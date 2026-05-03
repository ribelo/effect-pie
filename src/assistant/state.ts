export type AssistantMode =
  | "idle"
  | "ptt-transcribe"
  | "ptt-translate"
  | "wakeword-dictation"
  | "stt"
  | "injection"

export type AssistantState = {
  readonly mode: AssistantMode
  readonly pttActive: boolean
  readonly transcribing: boolean
  readonly injecting: boolean
}

export const assistantIdle: AssistantState = {
  mode: "idle",
  pttActive: false,
  transcribing: false,
  injecting: false,
}

export const canAcceptWakewordTrigger = (state: AssistantState): boolean =>
  state.mode === "idle" && !state.pttActive && !state.transcribing && !state.injecting

export const canSwitchPttMode = (
  state: AssistantState,
  mode: "transcribe" | "translate",
): boolean => {
  if (state.pttActive) {
    return state.mode === `ptt-${mode}`
  }
  return state.mode === "idle" || state.mode === `ptt-${mode}`
}

export const assistantPttHold = (
  state: AssistantState,
  mode: "transcribe" | "translate",
): AssistantState => {
  if (!canSwitchPttMode(state, mode)) {
    return state
  }
  return {
    ...state,
    mode: `ptt-${mode}` as AssistantMode,
    pttActive: true,
  }
}

export const assistantPttRelease = (state: AssistantState): AssistantState => {
  if (!state.pttActive) {
    return state
  }
  return {
    ...state,
    pttActive: false,
  }
}

export const assistantPttFinalize = (
  state: AssistantState,
  durationMs: number,
  minDurationMs: number,
): AssistantState => {
  if (state.pttActive) {
    return state
  }
  if (durationMs < minDurationMs) {
    return {
      ...state,
      mode: "idle",
    }
  }
  return {
    ...state,
    mode: "stt",
  }
}

export const assistantWakewordTrigger = (state: AssistantState): AssistantState => {
  if (!canAcceptWakewordTrigger(state)) {
    return state
  }
  return {
    ...state,
    mode: "wakeword-dictation",
  }
}

export const assistantDictationComplete = (state: AssistantState): AssistantState => {
  if (state.mode !== "wakeword-dictation") {
    return state
  }
  return {
    ...state,
    mode: "stt",
  }
}

export const assistantSttStart = (state: AssistantState): AssistantState => {
  if (state.mode !== "stt") {
    return state
  }
  return {
    ...state,
    transcribing: true,
  }
}

export const assistantSttComplete = (state: AssistantState): AssistantState => {
  if (!state.transcribing) {
    return state
  }
  return {
    ...state,
    mode: "injection",
    transcribing: false,
  }
}

export const assistantSttFailure = (state: AssistantState): AssistantState => {
  if (!state.transcribing) {
    return state
  }
  return {
    ...state,
    mode: "idle",
    transcribing: false,
  }
}

export const assistantInjectionStart = (state: AssistantState): AssistantState => {
  if (state.mode !== "injection") {
    return state
  }
  return {
    ...state,
    injecting: true,
  }
}

export const assistantInjectionComplete = (state: AssistantState): AssistantState => {
  if (!state.injecting) {
    return state
  }
  return {
    ...state,
    mode: "idle",
    injecting: false,
  }
}

export const assistantInjectionFailure = (state: AssistantState): AssistantState => {
  if (!state.injecting) {
    return state
  }
  return {
    ...state,
    mode: "idle",
    injecting: false,
  }
}

export const assistantShutdown = (): AssistantState => assistantIdle
