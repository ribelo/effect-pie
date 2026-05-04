import { Effect, Ref } from "effect"

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

export type WakewordTriggerMachine = {
  readonly processFrame: (
    frame: WakewordScoreFrame,
  ) => Effect.Effect<ReadonlyArray<WakewordTriggerEvent>>
  readonly reset: Effect.Effect<void>
}

export const createWakewordTriggerMachine = (
  partialConfig: Partial<WakewordTriggerConfig> = {},
): Effect.Effect<WakewordTriggerMachine> =>
  Effect.gen(function* () {
    const config: WakewordTriggerConfig = {
      ...defaultConfig,
      ...partialConfig,
    }

    const modelStatesRef = yield* Ref.make<Map<string, TriggerModelState>>(new Map())

    const getOrCreateModelState = (
      map: Map<string, TriggerModelState>,
      model: string,
    ): TriggerModelState => {
      const existing = map.get(model)
      if (existing !== undefined) {
        return existing
      }
      const created: TriggerModelState = {
        recentScores: [],
        consecutiveAboveThreshold: 0,
        cooldownUntilMs: 0,
      }
      map.set(model, created)
      return created
    }

    const processFrame = (
      frame: WakewordScoreFrame,
    ): Effect.Effect<ReadonlyArray<WakewordTriggerEvent>> =>
      Ref.modify(modelStatesRef, (map) => {
        const events: Array<WakewordTriggerEvent> = []

        for (const [model, rawScore] of Object.entries(frame.scores)) {
          const modelState = getOrCreateModelState(map, model)
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

        return [events, map] as const
      })

    const reset = Ref.set(modelStatesRef, new Map())

    return { processFrame, reset }
  })
