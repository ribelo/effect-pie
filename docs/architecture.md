# Architecture

## Purpose

pie is a TypeScript/Effect 4.0 port of PIE (Personal Intelligence Engine). It provides voice-activated command execution on Linux through audio capture, wake-word detection, and AI-powered command routing.

## Directory Structure

```
pie/
├── assets/openwakeword/       # bundled fallback assets for local/dev bootstrap
├── src/
│   ├── cli.ts                 # CLI entrypoint (record + wakeword commands)
│   ├── desktop/               # Desktop session detection helpers
│   ├── input/                 # Text injection orchestration
│   ├── pulse/                 # PulseAudio native protocol client and stream wrappers
│   ├── wakeword/              # openWakeWord asset validation, ONNX runtime, pipeline, trigger
│   ├── wayland/               # Wayland typing/portal integration
│   └── x11/                   # X11 typing integration
├── test/                      # Unit + integration tests
├── docs/
│   ├── architecture.md
│   ├── qa.md
│   └── wayland-ptt-wtype.md
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
- `pie record` captures raw PCM audio.
- `pie sources` lists available PulseAudio capture sources.
- `pie meter` prints live RMS / peak levels for input verification and threshold tuning.
- `pie` (no subcommand) runs combined assistant mode: wakeword (`ok_pie`) transcription + PTT transcription + PTT translation.
- Combined assistant mode writes runtime recording state to `$XDG_RUNTIME_DIR/pie/recording.json` with `active`, `mode`, `startedAt`, and `updatedAt` for external status widgets (for example Quickshell).
- `pie ptt-portal` registers a GlobalShortcuts portal binding and prints activation/deactivation monitor events.
- `pie ptt-transcribe` records push-to-talk audio and transcribes with the configured STT provider (Codex realtime by default; model from `$XDG_CONFIG_HOME/pie/stt.json`).
- `pie ptt-translate` records push-to-talk audio and performs single-pass transcription+translation with the configured STT provider (Codex realtime by default; model from `$XDG_CONFIG_HOME/pie/stt.json`).
- Default combined assistant mode binds PTT keysyms `F9` (transcribe) and `F10` (translate).
- `pie stt-interactive` runs an Enter-to-start / Enter-to-stop transcription loop using the configured STT provider and can type streamed deltas with `wtype`.
- `pie type` sends text to the focused app and auto-selects backend (`wtype` for Wayland, `xdotool` for X11).
- `pie wakeword` runs live wakeword scoring/trigger telemetry from PulseAudio.
- `pie wakeword-train` runs best-effort capture setup (auto source probing, auto noise/speech calibration, adaptive speech threshold retries), collects positive/negative clips from PulseAudio, trains a lightweight wakeword scoring model, saves data under `$XDG_DATA_HOME/pie/openwakeword/`, updates the XDG manifest when requested, and persists calibration snapshots in `$XDG_CONFIG_HOME/pie/wakeword/`.
- STT model and language routing for assistant, `ptt-transcribe`, `ptt-translate`, and `stt-interactive` is configured in `$XDG_CONFIG_HOME/pie/stt.json` using schema version 2. The default provider is `codex-realtime`, authenticated from `CODEX_HOME/auth.json` when `CODEX_HOME` is set or `~/.codex/auth.json` otherwise. Codex realtime uses authenticated WebSockets; OpenRouter remains available only when `provider` is explicitly set to `openrouter`.
  - provider: `codex-realtime`
  - transcription model: `gpt-realtime-whisper`
  - translation model: `gpt-realtime-translate`
  - transcription language: `English`
  - translation source language: `English`
  - translation target language: `English`
  - wakeword dictation trailing silence: `3` seconds
  - wakeword dictation max capture: `120` seconds
  - wakeword dictation speech RMS threshold: `0.01`
- Wakeword feature extraction now requires real ONNX feature models (`melspectrogram.onnx`, `embedding_model.onnx`) and `onnxruntime-web@1.22.0`; placeholder/fallback feature paths are rejected.

## Data Flow

```
PulseAudio PCM stream
  -> openWakeWord pipeline (melspectrogram -> embedding -> wakeword score)
  -> trigger state machine (threshold + smoothing + cooldown)
  -> trigger events / score telemetry
```
