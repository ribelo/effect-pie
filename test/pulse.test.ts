import { expect, test } from "bun:test";
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

test("connects to PulseAudio and records audio", async () => {
  if (!(await hasPulseSocket())) {
    return;
  }

  const program = Effect.gen(function* () {
    const client = yield* PulseAudioClient;

    yield* client.connect();

    const serverInfo = yield* client.getServerInfo;
    expect(serverInfo.name.length).toBeGreaterThan(0);

    const sources = yield* client.listSources;
    expect(sources.length).toBeGreaterThan(0);

    const byteCountRef = yield* Ref.make(0);

    const recorderFiber = yield* createRecordStream({ fragmentSize: 1024 }).pipe(
      Stream.runForEach((chunk) => Ref.update(byteCountRef, (current) => current + chunk.length)),
      Effect.forkDetach,
    );

    yield* Effect.sleep("1 second");
    yield* Fiber.interrupt(recorderFiber);

    const byteCount = yield* Ref.get(byteCountRef);
    expect(byteCount).toBeGreaterThan(0);

    yield* client.disconnect;
  }).pipe(
    Effect.timeoutOrElse({
      duration: "20 seconds",
      onTimeout: () => Effect.fail(new Error("PulseAudio integration test timed out")),
    }),
    Effect.provide(layer()),
  );

  await Effect.runPromise(program);
}, 30_000);
