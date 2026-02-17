# Decisions

## Technology

| Decision                 | Rationale                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------- |
| Effect 4.0 (effect-smol) | Matches erg project; structured concurrency, services, layers for daemon architecture |
| Bun runtime              | Fast startup, native TS, good for CLI/daemon                                          |
| oxlint + oxfmt           | Fast linting/formatting, matches erg tooling                                          |
| tsgo                     | Fast typecheck, matches erg tooling                                                   |

## Scope

| Decision                | Rationale                                                                   |
| ----------------------- | --------------------------------------------------------------------------- |
| Port of PIE (Rust)      | Same feature set -- audio capture, wake word, AI routing, command pipelines |
| CLI/daemon architecture | Same as original -- `effect-pi daemon`, `effect-pi run <name>`, etc.        |

## Wakeword Runtime

| Decision                              | Rationale                                                                                                                        |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| openWakeWord model stack              | Python-free wakeword path in Bun with melspectrogram + embedding models and wakeword scoring (`.onnx` or trained `.json`)        |
| Runtime pin: `onnxruntime-web@1.22.0` | Keep inference runtime deterministic and Bun-compatible                                                                          |
| XDG storage layout                    | Runtime data lives under `$XDG_DATA_HOME/effect-pi/openwakeword`, tuning/calibration under `$XDG_CONFIG_HOME/effect-pi/wakeword` |

## Verification Workflow

- Validate project quality gate: `bun run gate`
- List available capture sources: `bun run cli -- sources`
- Check live input level / RMS for threshold tuning: `bun run cli -- meter --duration 10 --source <source-name>`
- Install real feature models first (required): `bun run wakeword:install-feature-models --melspectrogram-sha256 <sha256> --embedding-sha256 <sha256>`
- Recommended one-command training (auto source + auto RMS calibration + adaptive retries): `bun run cli -- wakeword-train --name hey_jarvis --register`
- Automatic trigger tuning (writes config snapshot used by `wakeword`): `bun run cli -- wakeword-tune --model hey_jarvis.json`
- Auto source probe + calibration are now sequential and interactive: press Enter to start each capture step, then press Enter again to stop/confirm.
- Optional manual tuning overrides: `--source`, `--speech-rms`, `--speech-chunks`, `--pre-roll-ms`, `--max-wait-seconds`, `--no-auto-calibrate`, `--recalibrate`
- Validate wakeword assets only: `bun run cli -- wakeword --duration 1 --score-every 1`
- Record raw PCM for local troubleshooting: `bun run cli -- record --duration 3 --output /tmp/sample.pcm`

## Open Questions

- Performance profiling on low-power CPUs once real ONNX assets are checked in locally
- Final default wakeword model set and threshold presets per model
