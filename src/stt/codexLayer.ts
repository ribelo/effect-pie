import { Effect, Layer, Stream } from "effect"

import { CodexRealtimeSttService } from "./codexRealtimeService.js"
import { CodexAuthService } from "./codexAuth.js"
import { SttService } from "./service.js"
import type { SttRuntimeConfig } from "./config.js"

export const codexSttLayer = (
  sttConfig: SttRuntimeConfig,
): Layer.Layer<SttService, never, CodexRealtimeSttService | CodexAuthService> =>
  Layer.effect(
    SttService,
    Effect.gen(function* () {
      const codex = yield* CodexRealtimeSttService
      return SttService.of({
        transcribe: (config) =>
          codex.transcribe({
            model: config.model,
            inputSampleRate: config.sampleRate,
            audio: Stream.succeed(config.pcmBytes),
            language: config.language,
            promptTemplate: config.promptTemplate,
            ...(config.onDelta !== undefined ? { onDelta: config.onDelta } : {}),
          }),
        translate: (config) =>
          codex.translate({
            model: config.model,
            inputSampleRate: config.sampleRate,
            audio: Stream.succeed(config.pcmBytes),
            sourceLanguage: config.sourceLanguage,
            targetLanguage: config.targetLanguage,
            promptTemplate: config.promptTemplate,
            ...(config.onDelta !== undefined ? { onDelta: config.onDelta } : {}),
          }),
        transcribeStream: (config) =>
          codex.transcribe({
            model: config.model,
            inputSampleRate: config.sampleRate,
            audio: config.audio,
            language: config.language,
            promptTemplate: config.promptTemplate,
            ...(config.onDelta !== undefined ? { onDelta: config.onDelta } : {}),
          }),
        translateStream: (config) =>
          codex.translate({
            model: config.model,
            inputSampleRate: config.sampleRate,
            audio: config.audio,
            sourceLanguage: config.sourceLanguage,
            targetLanguage: config.targetLanguage,
            promptTemplate: config.promptTemplate,
            ...(config.onDelta !== undefined ? { onDelta: config.onDelta } : {}),
          }),
      })
    }),
  )
