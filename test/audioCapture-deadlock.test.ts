import { describe, it } from "node:test"
import { strict as assert } from "node:assert"
import { Cause, Effect, Exit } from "effect"
import {
  recordVoiceActivatedClip,
  recordPcmUntilTrailingSilence,
} from "../src/commands/audioCapture.js"
import { PulseAudioClient, PulseAudioClientError } from "../src/pulse/client.js"
import { NoSpeechDetectedError } from "../src/commands/shared.js"

// Minimal fake PulseAudioClient that fails immediately on openRecordStream
const FailingPulseClient = {
  getServerInfo: Effect.fail(new PulseAudioClientError({ message: "no server" })),
  listSources: Effect.fail(new PulseAudioClientError({ message: "no sources" })),
  openRecordStream: () => Effect.fail(new PulseAudioClientError({ message: "socket failed" })),
  closeRecordStream: () => Effect.void,
  acquireRecordStream: () => Effect.fail(new PulseAudioClientError({ message: "socket failed" })),
} as const

const config = {
  clipSeconds: 1,
  maxWaitSeconds: 1,
  speechRmsThreshold: 0.1,
  minActiveChunks: 1,
  preRollMs: 100,
  fragmentSize: 320,
  sampleRate: 16000,
  channels: 1,
}

describe("recordVoiceActivatedClip failure propagation", () => {
  it("should propagate stream failure immediately instead of hanging or masking it", async () => {
    const program = recordVoiceActivatedClip(config).pipe(
      Effect.provideService(PulseAudioClient, FailingPulseClient),
      // generous safety net so the test suite never hangs
      Effect.timeout("5 seconds"),
    )

    const exit = await Effect.runPromiseExit(program)

    if (!Exit.isFailure(exit)) {
      assert.fail("expected failure")
    }
    const cause = exit.cause

    // Must NOT be a TimeoutError — the underlying failure should propagate
    const hasTimeout = cause.reasons.some(
      (r) => Cause.isFailReason(r) && r.error instanceof Cause.TimeoutError,
    )
    assert.ok(!hasTimeout, "got TimeoutError — stream failure was not propagated")

    // Must NOT be NoSpeechDetectedError — that's the masked timeout fallback
    const hasNoSpeech = cause.reasons.some(
      (r) => Cause.isFailReason(r) && r.error instanceof NoSpeechDetectedError,
    )
    assert.ok(
      !hasNoSpeech,
      "got NoSpeechDetectedError — stream failure was masked by timeoutOrElse",
    )

    // Must contain the actual underlying error
    const hasActualError = cause.reasons.some(
      (r) =>
        Cause.isFailReason(r) &&
        r.error instanceof Error &&
        r.error.message.includes("socket failed"),
    )
    assert.ok(hasActualError, `expected actual stream error, got: ${Cause.pretty(cause)}`)
  })
})

describe("recordPcmUntilTrailingSilence failure propagation", () => {
  it("should propagate stream failure immediately", async () => {
    const program = recordPcmUntilTrailingSilence({
      silenceSeconds: 1,
      maxSeconds: 2,
      speechRmsThreshold: 0.1,
      fragmentSize: 320,
      sampleRate: 16000,
      channels: 1,
    }).pipe(
      Effect.provideService(PulseAudioClient, FailingPulseClient),
      Effect.timeout("5 seconds"),
    )

    const exit = await Effect.runPromiseExit(program)

    if (!Exit.isFailure(exit)) {
      assert.fail("expected failure")
    }
    const cause = exit.cause

    const hasTimeout = cause.reasons.some(
      (r) => Cause.isFailReason(r) && r.error instanceof Cause.TimeoutError,
    )
    assert.ok(!hasTimeout, "got TimeoutError — stream failure was not propagated")

    const hasActualError = cause.reasons.some(
      (r) =>
        Cause.isFailReason(r) &&
        r.error instanceof Error &&
        r.error.message.includes("socket failed"),
    )
    assert.ok(hasActualError, `expected actual stream error, got: ${Cause.pretty(cause)}`)
  })
})
