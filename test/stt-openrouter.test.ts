import { expect, test } from "bun:test";
import { Effect, Exit } from "effect";

import {
  decodeStructuredTransciption,
  decodeStructuredTranslation,
  encodePcm16MonoWav,
} from "../src/stt/openrouter.js";

test("encodePcm16MonoWav writes a RIFF/WAVE payload", () => {
  const pcm = new Uint8Array([0x00, 0x00, 0xff, 0x7f]);
  const wav = encodePcm16MonoWav(pcm, 16_000);

  expect(wav.length).toBe(48);
  expect(String.fromCharCode(...wav.slice(0, 4))).toBe("RIFF");
  expect(String.fromCharCode(...wav.slice(8, 12))).toBe("WAVE");
  expect(String.fromCharCode(...wav.slice(36, 40))).toBe("data");
});

test("decodeStructuredTransciption reads the transciption field", async () => {
  const decoded = await Effect.runPromise(decodeStructuredTransciption('{"transciption":"hello"}'));
  expect(decoded).toBe("hello");
});

test("decodeStructuredTransciption accepts transcription alias", async () => {
  const decoded = await Effect.runPromise(
    decodeStructuredTransciption('{"transcription":"hello"}'),
  );
  expect(decoded).toBe("hello");
});

test("decodeStructuredTransciption fails when transcript field is missing", async () => {
  const exit = await Effect.runPromiseExit(decodeStructuredTransciption('{"text":"hello"}'));

  expect(Exit.isFailure(exit)).toBe(true);
});

test("decodeStructuredTranslation reads translation field", async () => {
  const decoded = await Effect.runPromise(decodeStructuredTranslation('{"translation":"hello"}'));
  expect(decoded).toBe("hello");
});

test("decodeStructuredTranslation accepts legacy transcription aliases", async () => {
  const decoded = await Effect.runPromise(
    decodeStructuredTranslation('{"transcription":"legacy"}'),
  );
  expect(decoded).toBe("legacy");
});
