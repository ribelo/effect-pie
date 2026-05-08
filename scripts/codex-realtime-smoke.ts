#!/usr/bin/env bun
/**
 * Operator-only smoke test for Codex realtime STT.
 *
 * Reads a local PCM16/WAV file, converts to 24 kHz mono PCM16 at the boundary,
 * opens a Codex realtime WebSocket session with the local Codex auth token, and
 * prints transcript deltas as they arrive. Does NOT run as part of `bun run gate`.
 *
 * Usage:
 *   bun run scripts/codex-realtime-smoke.ts --file path/to/audio.wav [--mode transcription|translation] [--target-language English]
 */
import { Effect, Stream } from "effect"
import * as fs from "node:fs/promises"
import * as path from "node:path"

import { ensureFreshCodexAuth } from "../src/stt/codexAuth.js"
import {
  bunWebSocketFactory,
  transcribeWithCodexRealtime,
  translateWithCodexRealtime,
} from "../src/stt/codexRealtimeService.js"
import {
  DEFAULT_CODEX_TRANSCRIPTION_MODEL,
  DEFAULT_CODEX_TRANSLATION_MODEL,
} from "../src/stt/codexRealtime.js"

type Args = {
  readonly file: string
  readonly mode: "transcription" | "translation"
  readonly sampleRate: number
  readonly sourceLanguage: string
  readonly targetLanguage: string | undefined
  readonly model: string | undefined
}

const parseArgs = (argv: ReadonlyArray<string>): Args => {
  const args = new Map<string, string>()
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!
    if (a.startsWith("--")) {
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith("--")) {
        args.set(a.slice(2), next)
        i += 1
      } else {
        args.set(a.slice(2), "true")
      }
    }
  }
  const file = args.get("file")
  if (file === undefined) {
    throw new Error("usage: --file <path.wav or raw-pcm>")
  }
  const mode = (args.get("mode") ?? "transcription") as "transcription" | "translation"
  if (mode !== "transcription" && mode !== "translation") {
    throw new Error(`invalid --mode ${mode}; expected transcription or translation`)
  }
  return {
    file,
    mode,
    sampleRate: Number.parseInt(args.get("sample-rate") ?? "24000", 10),
    sourceLanguage: args.get("source-language") ?? "source language",
    targetLanguage: args.get("target-language"),
    model: args.get("model"),
  }
}

const readWavOrRawPcm = async (file: string): Promise<Uint8Array> => {
  const bytes = await fs.readFile(file)
  if (path.extname(file).toLowerCase() === ".wav") {
    // Strip 44-byte RIFF/WAVE header (assumes PCM16 mono).
    return bytes.subarray(44)
  }
  return bytes
}

const main = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2))

  console.log(`[codex-smoke] mode=${args.mode} file=${args.file} rate=${args.sampleRate}`)

  const pcmBytes = await readWavOrRawPcm(args.file)
  console.log(`[codex-smoke] loaded ${pcmBytes.length} PCM bytes`)

  const auth = await Effect.runPromise(ensureFreshCodexAuth())
  const accessToken = auth.tokens.access_token
  console.log(`[codex-smoke] loaded Codex auth (token length=${accessToken.length})`)

  const audio = Stream.fromIterable([pcmBytes])

  const onDelta = (delta: string): Effect.Effect<void> =>
    Effect.sync(() => {
      process.stdout.write(delta)
    })

  if (args.mode === "transcription") {
    const model = args.model ?? DEFAULT_CODEX_TRANSCRIPTION_MODEL
    console.log(`[codex-smoke] connecting transcription model=${model}`)
    const transcript = await Effect.runPromise(
      transcribeWithCodexRealtime(bunWebSocketFactory, accessToken, {
        model,
        inputSampleRate: args.sampleRate,
        audio,
        onDelta,
      }),
    )
    console.log(`\n[codex-smoke] final transcript (${transcript.length} chars):`)
    console.log(transcript)
    return
  }

  const model = args.model ?? DEFAULT_CODEX_TRANSLATION_MODEL
  console.log(`[codex-smoke] connecting translation model=${model}`)
  const transcript = await Effect.runPromise(
    translateWithCodexRealtime(bunWebSocketFactory, accessToken, {
      model,
      inputSampleRate: args.sampleRate,
      audio,
      onDelta,
      sourceLanguage: args.sourceLanguage,
      promptTemplate:
        "Translate the spoken audio from {{source_language}} to {{target_language}}. Return only the translation.",
      ...(args.targetLanguage !== undefined ? { targetLanguage: args.targetLanguage } : {}),
    }),
  )
  console.log(`\n[codex-smoke] final translation (${transcript.length} chars):`)
  console.log(transcript)
}

main().catch((err) => {
  console.error("[codex-smoke] failed:", err)
  process.exit(1)
})
