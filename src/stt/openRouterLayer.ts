import { Effect, Layer, Stream } from "effect"

import { OpenRouterSttService } from "./openrouter.js"
import { SttService } from "./service.js"
import type { SttRuntimeConfig } from "./config.js"

const concatAudioChunks = (chunks: Iterable<Uint8Array>): Uint8Array => {
  let total = 0
  for (const chunk of chunks) {
    total += chunk.length
  }

  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

export const openRouterSttLayer = (
  _sttConfig: SttRuntimeConfig,
): Layer.Layer<SttService, never, OpenRouterSttService> =>
  Layer.effect(
    SttService,
    Effect.gen(function* () {
      const openrouter = yield* OpenRouterSttService
      return SttService.of({
        transcribe: openrouter.transcribe,
        translate: openrouter.translate,
        transcribeStream: (config) =>
          config.audio.pipe(
            Stream.runCollect,
            Effect.map(concatAudioChunks),
            Effect.flatMap((pcmBytes) => openrouter.transcribe({ ...config, pcmBytes })),
          ),
        translateStream: (config) =>
          config.audio.pipe(
            Stream.runCollect,
            Effect.map(concatAudioChunks),
            Effect.flatMap((pcmBytes) => openrouter.translate({ ...config, pcmBytes })),
          ),
      })
    }),
  )
