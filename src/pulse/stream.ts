import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"

import { PulseAudioClient, type PulseAudioClientError } from "./client.js"
import type { RecordStreamOptions } from "./defs.js"

export const createRecordStream = (
  options?: Partial<RecordStreamOptions>,
): Stream.Stream<Uint8Array, PulseAudioClientError, PulseAudioClient> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const client = yield* PulseAudioClient
      const opened = yield* client.openRecordStream(options)

      yield* Effect.addFinalizer(() =>
        client.closeRecordStream(opened.info.streamIndex).pipe(Effect.exit, Effect.asVoid),
      )

      return Stream.fromQueue(opened.queue)
    }),
  )
