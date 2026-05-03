import type { WakewordScoreFrame, WakewordTriggerEvent } from "./defs.js"

export type WakewordTriggerConfig = {
  readonly threshold: number
  readonly smoothingWindow: number
  readonly consecutiveFrames: number
  readonly cooldownMs: number
}

type TriggerModelState = {
  recentScores: Array<number>
  consecutiveAboveThreshold: number
  cooldownUntilMs: number
}

type TriggerState = {
  readonly modelStates: Record<string, TriggerModelState>
}

const defaultConfig: WakewordTriggerConfig = {
  threshold: 0.5,
  smoothingWindow: 4,
  consecutiveFrames: 3,
  cooldownMs: 1_500,
}

const average = (values: ReadonlyArray<number>): number => {
  if (values.length === 0) {
    return 0
  }
  const sum = values.reduce((acc, value) => acc + value, 0)
  return sum / values.length
}

const getModelState = (state: TriggerState, model: string): TriggerModelState => {
  const existing = state.modelStates[model]
  if (existing) {
    return existing
  }

  const created: TriggerModelState = {
    recentScores: [],
    consecutiveAboveThreshold: 0,
    cooldownUntilMs: 0,
  }

  state.modelStates[model] = created
  return created
}

export type WakewordTriggerMachine = {
  readonly processFrame: (frame: WakewordScoreFrame) => ReadonlyArray<WakewordTriggerEvent>
  readonly reset: () => void
}

export const createWakewordTriggerMachine = (
  partialConfig: Partial<WakewordTriggerConfig> = {},
): WakewordTriggerMachine => {
  const config: WakewordTriggerConfig = {
    ...defaultConfig,
    ...partialConfig,
  }

  const state: TriggerState = {
    modelStates: {},
  }

  const processFrame = (frame: WakewordScoreFrame): ReadonlyArray<WakewordTriggerEvent> => {
    const events: Array<WakewordTriggerEvent> = []

    for (const [model, rawScore] of Object.entries(frame.scores)) {
      const modelState = getModelState(state, model)
      modelState.recentScores.push(rawScore)

      while (modelState.recentScores.length > config.smoothingWindow) {
        modelState.recentScores.shift()
      }

      const smoothedScore = average(modelState.recentScores)

      if (smoothedScore >= config.threshold) {
        modelState.consecutiveAboveThreshold += 1
      } else {
        modelState.consecutiveAboveThreshold = 0
      }

      if (frame.timestampMs < modelState.cooldownUntilMs) {
        continue
      }

      if (modelState.consecutiveAboveThreshold < config.consecutiveFrames) {
        continue
      }

      modelState.cooldownUntilMs = frame.timestampMs + config.cooldownMs
      modelState.consecutiveAboveThreshold = 0

      events.push({
        timestampMs: frame.timestampMs,
        model,
        score: smoothedScore,
        rawScore,
      })
    }

    return events
  }

  return {
    processFrame,
    reset: () => {
      for (const modelState of Object.values(state.modelStates)) {
        modelState.recentScores = []
        modelState.consecutiveAboveThreshold = 0
        modelState.cooldownUntilMs = 0
      }
    },
  }
}
