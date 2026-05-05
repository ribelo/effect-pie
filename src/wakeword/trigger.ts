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

const defaultConfig: WakewordTriggerConfig = Object.freeze({
  threshold: 0.5,
  smoothingWindow: 4,
  consecutiveFrames: 3,
  cooldownMs: 1_500,
})

const average = (values: ReadonlyArray<number>): number => {
  if (values.length === 0) {
    throw new Error("average called with empty array")
  }
  const sum = values.reduce((acc, value) => acc + value, 0)
  return sum / values.length
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

  const modelStates = new Map<string, TriggerModelState>()

  const getOrCreateModelState = (model: string): TriggerModelState => {
    const existing = modelStates.get(model)
    if (existing !== undefined) {
      return existing
    }
    const created: TriggerModelState = {
      recentScores: [],
      consecutiveAboveThreshold: 0,
      cooldownUntilMs: 0,
    }
    modelStates.set(model, created)
    return created
  }

  const processFrame = (frame: WakewordScoreFrame): ReadonlyArray<WakewordTriggerEvent> => {
    const events: Array<WakewordTriggerEvent> = []

    for (const [model, rawScore] of Object.entries(frame.scores)) {
      const modelState = getOrCreateModelState(model)
      const nextScores = [...modelState.recentScores, rawScore].slice(-config.smoothingWindow)
      const smoothedScore = average(nextScores)

      const nextConsecutive =
        smoothedScore >= config.threshold ? modelState.consecutiveAboveThreshold + 1 : 0

      if (frame.timestampMs < modelState.cooldownUntilMs) {
        modelStates.set(model, {
          ...modelState,
          recentScores: nextScores,
          consecutiveAboveThreshold: nextConsecutive,
        })
        continue
      }

      if (nextConsecutive < config.consecutiveFrames) {
        modelStates.set(model, {
          ...modelState,
          recentScores: nextScores,
          consecutiveAboveThreshold: nextConsecutive,
        })
        continue
      }

      modelStates.set(model, {
        recentScores: nextScores,
        consecutiveAboveThreshold: 0,
        cooldownUntilMs: frame.timestampMs + config.cooldownMs,
      })

      events.push({
        timestampMs: frame.timestampMs,
        model,
        score: smoothedScore,
        rawScore,
      })
    }

    return events
  }

  const reset = (): void => {
    modelStates.clear()
  }

  return { processFrame, reset }
}
