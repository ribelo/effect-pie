import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

import type { ResolvedWakewordAssets } from "./defs.js"
import {
  loadWakewordModelSessions,
  type WakewordModelSessions,
  type WakewordRuntimeError,
} from "./onnx.js"
import {
  makeWakewordPipeline,
  type WakewordPipeline,
  type WakewordPipelineConfig,
  type WakewordPipelineError,
} from "./pipeline.js"

export class WakewordModelService extends Context.Service<
  WakewordModelService,
  {
    readonly sessions: WakewordModelSessions
  }
>()("pie/wakeword/WakewordModelService") {}

export const WakewordModelServiceLive = (
  assets: ResolvedWakewordAssets,
): Layer.Layer<WakewordModelService, WakewordRuntimeError> =>
  Layer.effect(WakewordModelService)(
    Effect.gen(function* () {
      const sessions = yield* loadWakewordModelSessions(assets)
      yield* Effect.addFinalizer(() => sessions.dispose)
      return WakewordModelService.of({ sessions })
    }),
  )

export class WakewordPipelineService extends Context.Service<
  WakewordPipelineService,
  {
    readonly pipeline: WakewordPipeline
  }
>()("pie/wakeword/WakewordPipelineService") {}

export const WakewordPipelineServiceLive = (
  config?: WakewordPipelineConfig,
): Layer.Layer<WakewordPipelineService, WakewordPipelineError, WakewordModelService> =>
  Layer.effect(
    WakewordPipelineService,
    Effect.gen(function* () {
      const modelService = yield* WakewordModelService
      const pipeline = yield* makeWakewordPipeline(modelService.sessions, config)
      return WakewordPipelineService.of({ pipeline })
    }),
  )
