import { describe, expect, test } from "bun:test";

import { createWakewordTriggerMachine } from "../src/wakeword/trigger.ts";

describe("wakeword trigger machine", () => {
  test("emits only after smoothed consecutive scores exceed threshold", () => {
    const machine = createWakewordTriggerMachine({
      threshold: 0.6,
      smoothingWindow: 3,
      consecutiveFrames: 2,
      cooldownMs: 500,
    });

    const events = [
      machine.processFrame({ timestampMs: 0, sampleIndex: 0, scores: { jarvis: 0.5 } }),
      machine.processFrame({ timestampMs: 100, sampleIndex: 1_280, scores: { jarvis: 0.7 } }),
      machine.processFrame({ timestampMs: 200, sampleIndex: 2_560, scores: { jarvis: 0.8 } }),
      machine.processFrame({ timestampMs: 300, sampleIndex: 3_840, scores: { jarvis: 0.9 } }),
    ].flat();

    expect(events.length).toBe(1);
    expect(events[0]?.model).toBe("jarvis");
  });

  test("respects cooldown to prevent rapid duplicate triggers", () => {
    const machine = createWakewordTriggerMachine({
      threshold: 0.5,
      smoothingWindow: 1,
      consecutiveFrames: 1,
      cooldownMs: 1_000,
    });

    const first = machine.processFrame({
      timestampMs: 0,
      sampleIndex: 0,
      scores: { jarvis: 0.9 },
    });

    const suppressed = machine.processFrame({
      timestampMs: 100,
      sampleIndex: 1_280,
      scores: { jarvis: 0.95 },
    });

    const second = machine.processFrame({
      timestampMs: 1_200,
      sampleIndex: 2_560,
      scores: { jarvis: 0.93 },
    });

    expect(first.length).toBe(1);
    expect(suppressed.length).toBe(0);
    expect(second.length).toBe(1);
  });
});
