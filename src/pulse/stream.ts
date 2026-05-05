import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"

import {
  PulseAudioClient,
  type PulseAudioClientError,
  type PulseAudioParseError,
} from "./client.js"
import type { RecordStreamOptions } from "./defs.js"

export const createRecordStream = (
  options?: Partial<RecordStreamOptions>,
): Stream.Stream<Uint8Array, PulseAudioClientError | PulseAudioParseError, PulseAudioClient> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const client = yield* Effect.service(PulseAudioClient)
      const opened = yield* client.acquireRecordStream(options)

      return Stream.fromQueue(opened.queue)
    }),
  )
