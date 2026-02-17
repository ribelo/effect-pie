# Architecture

## Purpose

effect-pi is a TypeScript/Effect 4.0 port of PIE (Personal Intelligence Engine). It provides voice-activated command execution on Linux through audio capture, wake-word detection, and AI-powered command routing.

## Directory Structure

```
effect-pi/
├── assets/openwakeword/       # openWakeWord model manifest and ONNX assets
├── src/
│   ├── cli.ts                 # CLI entrypoint (record + wakeword commands)
│   ├── pulse/                 # PulseAudio native protocol client and stream wrappers
│   └── wakeword/              # openWakeWord asset validation, ONNX runtime, pipeline, trigger
├── test/                      # Unit + integration tests
├── docs/
│   ├── architecture.md
│   └── qa.md
├── AGENTS.md
├── package.json
├── tsconfig.json
└── tsconfig.check.json
```

## Core Components

- PulseAudio transport:
- `src/pulse/client.ts` manages the native protocol socket, command/reply tags, and record stream lifecycle.
- `src/pulse/stream.ts` exposes Effect `Stream<Uint8Array>` chunks for live PCM audio.
- openWakeWord assets and runtime:
- `src/wakeword/assets.ts` validates manifest/runtime pins and required model files at startup.
- `src/wakeword/onnx.ts` loads ONNX sessions through a Bun-compatible JS runtime; wakeword detection/training requires real ONNX feature models and the pinned runtime (no fallback execution path).
- Wakeword inference pipeline:
- `src/wakeword/pipeline.ts` performs PCM framing, melspectrogram inference, embedding inference, and wakeword score inference.
- Trigger state machine:
- `src/wakeword/trigger.ts` turns noisy frame scores into stable trigger events with smoothing and cooldown.
- Live orchestration:
- `src/wakeword/live.ts` wires PulseAudio chunks to pipeline + trigger and emits telemetry events.
- CLI surface:
- `effect-pi record` captures raw PCM audio.
- `effect-pi sources` lists available PulseAudio capture sources.
- `effect-pi meter` prints live RMS / peak levels for input verification and threshold tuning.
- `effect-pi wakeword` runs live wakeword scoring/trigger telemetry from PulseAudio.
- `effect-pi wakeword-train` runs best-effort capture setup (auto source probing, auto noise/speech calibration, adaptive speech threshold retries), collects positive/negative clips from PulseAudio, trains a lightweight wakeword scoring model, saves it under `assets/openwakeword/wakewords/`, can register it in the manifest, and persists calibration snapshots in the training workspace for reuse.
- Wakeword feature extraction now requires real ONNX feature models (`melspectrogram.onnx`, `embedding_model.onnx`) and `onnxruntime-web@1.22.0`; placeholder/fallback feature paths are rejected.

## Data Flow

```
PulseAudio PCM stream
  -> openWakeWord pipeline (melspectrogram -> embedding -> wakeword score)
  -> trigger state machine (threshold + smoothing + cooldown)
  -> trigger events / score telemetry
```
