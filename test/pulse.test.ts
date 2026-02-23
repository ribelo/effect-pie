import { test } from "node:test";
import * as assert from "node:assert/strict";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { promises as fs } from "node:fs";

import { PA_DEFAULT_SOCKET_PATH } from "../src/pulse/defs.ts";
import { PulseAudioClient, layer } from "../src/pulse/client.ts";
import { createRecordStream } from "../src/pulse/stream.ts";

const hasPulseSocket = async (): Promise<boolean> => {
  try {
    await fs.access(PA_DEFAULT_SOCKET_PATH);
    return true;
  } catch {
    return false;
  }
};

test("connects to PulseAudio and records audio", { timeout: 30_000 }, async () => {
  if (!(await hasPulseSocket())) {
    return;
  }

  const program = Effect.gen(function* () {
    const client = yield* PulseAudioClient;

    yield* client.connect();

    const serverInfo = yield* client.getServerInfo;
    assert.ok(serverInfo.name.length > 0);

    const sources = yield* client.listSources;
    assert.ok(sources.length > 0);

    const byteCountRef = yield* Ref.make(0);

    const recorderFiber = yield* createRecordStream({ fragmentSize: 1024 }).pipe(
      Stream.runForEach((chunk) => Ref.update(byteCountRef, (current) => current + chunk.length)),
      Effect.forkDetach,
    );

    yield* Effect.sleep("1 second");
    yield* Fiber.interrupt(recorderFiber);

    const byteCount = yield* Ref.get(byteCountRef);
    assert.ok(byteCount > 0);

    yield* client.disconnect;
  }).pipe(
    Effect.timeoutOrElse({
      duration: "20 seconds",
      onTimeout: () => Effect.fail(new Error("PulseAudio integration test timed out")),
    }),
    Effect.provide(layer()),
  );

  await Effect.runPromise(program);
});
