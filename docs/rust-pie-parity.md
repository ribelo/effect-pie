# Rust PIE to Effect PIE Parity

## Purpose

This document compares the current Rust implementation in `../pie` with the current TypeScript/Effect implementation in this repository.

The migration direction is one-way: **keep `effect-pie` as the active implementation and move useful Rust-only behavior into it**. Do not remove Effect-only commands just because Rust removed them.

## Scope and evidence

Compared repositories:

| Repository | Path                                      | State used                                                              |
| ---------- | ----------------------------------------- | ----------------------------------------------------------------------- |
| Effect PIE | `/home/ribelo/projects/ribelo/effect-pie` | Working tree at `master`, including the new document being written here |
| Rust PIE   | `/home/ribelo/projects/ribelo/pie`        | Current working tree, including uncommitted Rust changes                |

Important evidence files:

| Area               | Rust                                                                                                                      | Effect                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| CLI surface        | `../pie/crates/pie-cli/src/main.rs`                                                                                       | `src/cli.ts`                                                 |
| Combined assistant | `../pie/crates/pie-cli/src/combined_mode.rs`, `../pie/crates/pie-cli/src/runtime.rs`, `../pie/crates/pie-core/src/app.rs` | `src/cli.ts`                                                 |
| Core state model   | `../pie/crates/pie-core/src/model.rs`, `../pie/crates/pie-core/src/events.rs`, `../pie/crates/pie-core/src/effects.rs`    | mostly inline in `src/cli.ts`                                |
| Audio              | `../pie/crates/pie-audio/src/*`, `../pie/crates/pie-cli/src/runtime.rs`, `../pie/crates/pie-cli/src/commands/record.rs`   | `src/pulse/*`, `src/cli.ts`                                  |
| STT                | `../pie/crates/pie-stt/src/config.rs`, `../pie/crates/pie-stt/src/client.rs`, `../pie/crates/pie-stt/assets/prompts/*`    | `src/stt/config.ts`, `src/stt/openrouter.ts`                 |
| Wakeword           | `../pie/crates/pie-wakeword/src/*`, `../pie/crates/pie-cli/src/commands/wakeword_train.rs`                                | `src/wakeword/*`, `src/cli.ts`                               |
| Desktop            | `../pie/crates/pie-desktop/src/*`                                                                                         | `src/desktop/*`, `src/input/*`, `src/wayland/*`, `src/x11/*` |
| Current docs       | `../pie/docs/architecture.md`, `../pie/docs/qa.md`                                                                        | `docs/architecture.md`, `docs/qa.md`                         |

## Executive summary

`effect-pie` has the broader operator CLI and the faster development loop. Rust has several better runtime behaviors that should be ported back:

1. **PTT capture quality:** 2 second post-roll after key release, silence filtering before STT, RMS/peak normalization, and muted-microphone notification.
2. **Prompt management:** user-editable STT prompt files under `$XDG_CONFIG_HOME/pie/prompts/`, with required-placeholder validation.
3. **Wakeword kill switch:** `openrouter.wakewordEnabled` in `stt.json`, applied at assistant startup.
4. **Wakeword training workflow:** persistent datasets, `--capture-negatives-only`, `--train-only`, silence clips, validation after training, and automatic trigger tuning as part of training.
5. **Operational diagnostics:** bounded shell trace on failures via `PIE_SHELL_TRACE=1`.
6. **Record command quality:** default-source resolution, gain normalization, RMS/peak summaries, parent-directory creation, and `--raw` escape hatch.

The most valuable port is not Rust syntax or syzygy itself. The valuable part is the **behavioral contract** Rust grew around capture, prompts, training data reuse, and operator diagnostics.

## Current CLI surface

Rust intentionally debloated its CLI. Effect currently exposes more standalone tools.

| Command                 | Rust `../pie`                | Effect `effect-pie` | Parity action                                                                            |
| ----------------------- | ---------------------------- | ------------------- | ---------------------------------------------------------------------------------------- |
| `pie` default assistant | Yes                          | Yes                 | Port Rust runtime behavior into Effect default assistant.                                |
| `record`                | Yes                          | Yes                 | Port Rust source resolution, normalization, metrics, `--raw`, and parent-dir creation.   |
| `sources`               | Yes                          | Yes                 | Mostly equivalent. Effect also prints usage hints.                                       |
| `wakeword-train`        | Yes                          | Yes                 | Port Rust persistent dataset and train-only modes.                                       |
| `type`                  | Yes                          | Yes                 | Keep Effect implementation; it already reports backend and has better fallback controls. |
| `meter`                 | Removed in Rust              | Yes                 | Keep Effect-only operator tool.                                                          |
| `ptt`                   | Removed in Rust              | Yes                 | Keep Effect-only clip-capture tool unless it becomes dead surface.                       |
| `ptt-portal`            | Removed in Rust              | Yes                 | Keep Effect-only portal probe.                                                           |
| `ptt-transcribe`        | Removed in Rust              | Yes                 | Keep Effect-only standalone flow. Optionally reuse Rust capture improvements.            |
| `ptt-translate`         | Removed in Rust              | Yes                 | Keep Effect-only standalone flow. Optionally reuse Rust capture improvements.            |
| `stt-interactive`       | Removed in Rust              | Yes                 | Keep Effect-only interactive streaming tool.                                             |
| `wakeword`              | Removed in Rust              | Yes                 | Keep Effect-only live telemetry tool.                                                    |
| `wakeword-tune`         | Folded into training in Rust | Yes                 | Keep as standalone, but also port Rust's train-and-tune integration.                     |

Rust's CLI removal happened in `../pie` around `cd0c476` (`refactor: debloat pie cli surface`). This is not a reason to delete Effect commands. It only means Rust no longer helps test those commands.

## Divergence timeline

| Point                          | What changed                                                                                                                                                                         | Evidence                                                                                                                                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-02-16 to 2026-02-21       | Effect implementation grew first as a direct Effect/Bun CLI with native PulseAudio protocol, wakeword runtime, tuning, PTT, OpenRouter STT, typing, and recording-state integration. | `effect-pie` commits `e00f2c0` through `cc72b71`; `src/cli.ts`, `src/pulse/*`, `src/wakeword/*`                                                                                                                |
| 2026-02-22 to 2026-02-23       | Rust implementation started as a port, but immediately chose a multi-crate architecture, libpulse bindings, and an Elm-style pure reducer/shell split.                               | `../pie` commits `0b8fb46`, `d348502`, `c152132`; `../pie/crates/pie-core/*`, `../pie/crates/pie-cli/src/runtime.rs`                                                                                           |
| 2026-02-23                     | Rust reached broad assistant parity: PTT keyboard monitor, RMS silence detection, recording state, STT config shape, and wakeword training.                                          | `../pie` commits `7ee7284`, `86ad915`, `53a706b`; `../pie/docs/qa.md`                                                                                                                                          |
| 2026-02-27 to 2026-03-13       | Rust diverged into runtime hardening: audio normalization, post-roll fixes, syzygy shell tasks/subscriptions, shell tracing, debloated CLI, and external STT prompts.                | `../pie` commits `23dd124`, `2e2322d`, `bca2837`, `66a0828`, `e43d77a`, `cd0c476`, `5d869ea`                                                                                                                   |
| Current uncommitted Rust state | Rust added or refined wakeword disable config, muted-microphone notification, persistent training dataset modes, stricter training validation, and prompt wording.                   | `../pie` working tree changes in `crates/pie-cli/src/runtime.rs`, `crates/pie-cli/src/commands/wakeword_train.rs`, `crates/pie-stt/src/config.rs`, `crates/pie-desktop/src/notification.rs`, `config/stt.json` |
| 2026-05-03                     | Effect moved back to Bun and current Effect tooling, but did not import the Rust runtime-hardening features.                                                                         | `effect-pie` commits `1923e43`, `f3ef4f2`, `ab8595a`                                                                                                                                                           |

The real divergence point is **after the initial Rust parity pass on 2026-02-23**. From then on, Rust optimized the always-on assistant runtime, while Effect accumulated a broader CLI and runtime/platform migrations.

## Rust-only or Rust-better functionality to port

### P0: PTT post-roll after key release

| Item          | Details                                                                                                                                                                                                    |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rust behavior | On `PttKeyUp`, Rust enters `AwaitingCaptureStop` and emits `AudioOperation::StopCaptureAfter { delay_ms: 2_000 }`. Audio chunks during the delay are still buffered.                                       |
| Rust files    | `../pie/crates/pie-core/src/app.rs`, `../pie/crates/pie-core/src/effects.rs`, `../pie/crates/pie-cli/src/runtime.rs`, `../pie/crates/pie-cli/src/combined_mode.rs`                                         |
| Effect gap    | `runAssistantPttCombinedLoop` stops collecting immediately on key release. Trailing speech is easy to cut off.                                                                                             |
| Effect files  | `src/cli.ts`                                                                                                                                                                                               |
| Port action   | Add a 2s post-roll to default assistant PTT capture before concatenating chunks and sending STT. Apply the same behavior to `ptt-transcribe` and `ptt-translate` if those commands remain operator-facing. |
| Tests         | Unit-test the PTT state/capture helper: release keeps accepting chunks until post-roll expires; short clips still ignore cleanly.                                                                          |

### P0: Silence and low-signal filtering before STT

| Item          | Details                                                                                                                                                                                                                      |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rust behavior | After capture stops, Rust ignores empty clips, short clips, and low-signal clips using `MIN_CAPTURE_RMS_FOR_STT = 0.003` and `MIN_CAPTURE_PEAK_FOR_STT = 0.02`.                                                              |
| Rust files    | `../pie/crates/pie-core/src/app.rs`, `../pie/crates/pie-cli/src/runtime.rs`, `../pie/crates/pie-cli/src/combined_mode.rs`                                                                                                    |
| Effect gap    | Effect PTT checks duration and empty buffers, but default assistant PTT does not reject low-RMS/low-peak clips before OpenRouter. Wakeword dictation has silence capture, but PTT does not get Rust's final low-signal gate. |
| Effect files  | `src/cli.ts`                                                                                                                                                                                                                 |
| Port action   | Reuse existing `pcmRms` / `pcmPeak` in `src/cli.ts` and gate PTT clips before STT. Log the same actionable ignored-silence message with observed RMS and peak.                                                               |
| Tests         | Add tests around the extracted PTT clip classifier: short, empty, silence, valid speech.                                                                                                                                     |

### P0: Capture normalization / auto gain

| Item          | Details                                                                                                                                                                                                                                      |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rust behavior | Rust normalizes non-silent PCM chunks to target RMS `0.12`, with max gain `40.0`, peak limit `0.95`, and silence thresholds matching STT filtering. It applies normalization during assistant capture and in `record` unless `--raw` is set. |
| Rust files    | `../pie/crates/pie-cli/src/runtime.rs`, `../pie/crates/pie-cli/src/commands/record.rs`                                                                                                                                                       |
| Effect gap    | Effect records and submits raw PCM. Quiet but valid clips can reach OpenRouter too quietly, and `record` does not report applied gain.                                                                                                       |
| Effect files  | `src/cli.ts`                                                                                                                                                                                                                                 |
| Port action   | Add a small PCM utility module for `pcmRms`, `pcmPeak`, `computeNormalizationGain`, and `normalizePcmS16leTargetRms`. Use it in assistant PTT/wakeword dictation and `record`; add `--raw` to bypass normalization.                          |
| Tests         | Port Rust's normalization tests: boost quiet speech, skip near-silence, avoid clipping.                                                                                                                                                      |

### P0: User-editable STT prompt files

| Item          | Details                                                                                                                                                                                                                                                      |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Rust behavior | On config load, Rust creates and validates `$XDG_CONFIG_HOME/pie/prompts/transcription.md` and `$XDG_CONFIG_HOME/pie/prompts/translation.md`. Prompts are user-editable and must contain required placeholders.                                              |
| Rust files    | `../pie/crates/pie-stt/src/config.rs`, `../pie/crates/pie-stt/assets/prompts/transcription.md`, `../pie/crates/pie-stt/assets/prompts/translation.md`                                                                                                        |
| Effect gap    | Effect hardcodes compact prompt strings in `src/stt/openrouter.ts`. Operators cannot tune STT/translation behavior without code changes.                                                                                                                     |
| Effect files  | `src/stt/config.ts`, `src/stt/openrouter.ts`                                                                                                                                                                                                                 |
| Port action   | Add prompt bootstrap/validation to `loadSttRuntimeConfig`. Return prompt templates with the runtime config or expose a separate loader. Use placeholders `{{language}}`, `{{source_language}}`, and `{{target_language}}`. Copy Rust default prompt wording. |
| Tests         | Create missing prompt files, preserve edited prompts, reject empty prompts, reject prompts missing placeholders.                                                                                                                                             |

### P0: Wakeword enable/disable config

| Item          | Details                                                                                                                                                                             |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rust behavior | Rust config has `openrouter.wakewordEnabled` with default `true`. `build_app_with_config` copies it into `model.wakeword.enabled`, and startup skips wakeword arming when disabled. |
| Rust files    | `../pie/crates/pie-stt/src/config.rs`, `../pie/crates/pie-cli/src/runtime.rs`, `../pie/crates/pie-core/src/app.rs`, `../pie/config/stt.json`                                        |
| Effect gap    | Effect default assistant always starts the wakeword loop. The only practical disable path is not starting `pie`, but that also disables PTT.                                        |
| Effect files  | `src/stt/config.ts`, `src/cli.ts`                                                                                                                                                   |
| Port action   | Add `wakewordEnabled` to `SttRuntimeConfig` and skip `runAssistantWakewordTranscribeLoop` when false while still running PTT. Write the field into generated config.                |
| Tests         | Config defaults to enabled; disabled config starts PTT-only assistant wiring.                                                                                                       |

### P1: Persistent wakeword training dataset modes

| Item          | Details                                                                                                                                                                                                                                              |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rust behavior | Rust stores `positive/`, `negative/`, and `silence/` WAVs under `$XDG_DATA_HOME/pie/openwakeword/training/<model>/`. It supports full capture, `--capture-negatives-only`, and `--train-only`. It can append negatives and retrain from saved clips. |
| Rust files    | `../pie/crates/pie-cli/src/commands/wakeword_train.rs`                                                                                                                                                                                               |
| Effect gap    | Effect saves positive/negative clips but lacks silence clips, train-only reuse, and negative-only append mode. Training is still mostly a one-shot capture flow.                                                                                     |
| Effect files  | `src/wakeword/training.ts`, `src/cli.ts`                                                                                                                                                                                                             |
| Port action   | Extend the Effect training plan with `silenceDir`; add WAV decoding; add `--capture-negatives-only` and `--train-only`; require minimum saved clips before training.                                                                                 |
| Tests         | Dataset loading, minimum clip validation, next clip numbering, invalid WAV rejection.                                                                                                                                                                |

### P1: Wakeword training validation and integrated auto-tuning

| Item          | Details                                                                                                                                                                                                                     |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rust behavior | After training, Rust loads the trained model, scores a positive clip, fails if validation produces no useful score, scores silence/negative/positive datasets, computes trigger config, and writes `detection-tuning.json`. |
| Rust files    | `../pie/crates/pie-cli/src/commands/wakeword_train.rs`, `../pie/crates/pie-wakeword/src/training.rs`, `../pie/crates/pie-wakeword/src/pipeline.rs`, `../pie/crates/pie-wakeword/src/trigger.rs`                             |
| Effect gap    | Effect has `wakeword-tune`, but training itself only suggests running `pie wakeword`. It does not validate the newly trained model or produce tuning in the same flow.                                                      |
| Effect files  | `src/cli.ts`, `src/wakeword/training.ts`                                                                                                                                                                                    |
| Port action   | Reuse Effect's existing tuning helpers from `wakeword-tune`, but drive them from the saved dataset after training. Write `detection-tuning.json` automatically unless disabled.                                             |
| Tests         | Training flow writes a tuning snapshot from synthetic scores; validation fails when no positive frames are produced.                                                                                                        |

### P1: Record command operator quality

| Item          | Details                                                                                                                                                                                                   |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rust behavior | `record` resolves a concrete source, creates output parent directories, trims capture to expected duration, normalizes unless `--raw`, and reports bytes, seconds, RMS, peak, gain, raw flag, and source. |
| Rust files    | `../pie/crates/pie-cli/src/commands/record.rs`, `../pie/crates/pie-cli/src/runtime.rs`                                                                                                                    |
| Effect gap    | Effect `record` captures bytes and optional output, but it does not resolve/print source, does not create output parent directories explicitly, does not normalize, and does not report RMS/peak/gain.    |
| Effect files  | `src/cli.ts`                                                                                                                                                                                              |
| Port action   | Add Rust's record reporting and normalization behavior. Keep Effect's `--fragment-size` flag.                                                                                                             |
| Tests         | Output parent dirs are created; raw keeps PCM unchanged; non-raw applies expected gain; summary includes source/gain/metrics.                                                                             |

### P1: Muted microphone / dead-input notification

| Item          | Details                                                                                                                                                                                             |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rust behavior | During PTT, Rust detects four consecutive all-zero PCM chunks, warns once per hold, and sends a desktop notification through `notify-rust`. Recording continues so release follows the normal path. |
| Rust files    | `../pie/crates/pie-cli/src/runtime.rs`, `../pie/crates/pie-desktop/src/notification.rs`, `../pie/crates/pie-desktop/src/lib.rs`                                                                     |
| Effect gap    | Effect logs capture progress but does not detect flatline input or notify the operator. A muted microphone looks like a normal empty/silent request until STT or silence handling finishes.         |
| Effect files  | `src/cli.ts`, no notification module today                                                                                                                                                          |
| Port action   | Add a tiny desktop notification helper, probably via D-Bus or a small `notify-send` wrapper. Add a PTT flatline detector with once-per-hold warning.                                                |
| Tests         | Detector warns after four zero chunks, resets on non-zero input, resets between holds, and stays idle outside PTT.                                                                                  |

### P1: Strict structured OpenRouter responses

| Item          | Details                                                                                                                                                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rust behavior | Rust sends `response_format.type = json_schema` with `strict = true` using schemars-generated schemas for transcription and translation output.                                                                           |
| Rust files    | `../pie/crates/pie-stt/src/client.rs`                                                                                                                                                                                     |
| Effect gap    | Effect uses `response_format.type = json_object` and then accepts raw non-JSON fallback when decoding fails. This is more permissive and can hide prompt/model drift.                                                     |
| Effect files  | `src/stt/openrouter.ts`                                                                                                                                                                                                   |
| Port action   | Prefer strict JSON schema for non-streaming calls. Keep streaming calls plain-text because schema streaming is not the same contract. Remove the raw-output fallback for structured calls if provider behavior is stable. |
| Tests         | Verify request payload includes strict schema; malformed structured response fails loudly.                                                                                                                                |

### P2: Shell trace and failure snapshot diagnostics

| Item          | Details                                                                                                                                                                                                                                                          |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | --- | ----------------------------------------------------------------------------------------------------- |
| Rust behavior | `PIE_SHELL_TRACE=1                                                                                                                                                                                                                                               | true | yes | on` enables bounded syzygy shell tracing. On shell failure, Rust prints the shell snapshot and trace. |
| Rust files    | `../pie/crates/pie-cli/src/runtime.rs`, `../pie/docs/qa.md`                                                                                                                                                                                                      |
| Effect gap    | Effect has Effect spans/logging in pieces, but no equivalent bounded assistant-state trace for capture/STT/text-injection orchestration failures.                                                                                                                |
| Effect files  | `src/cli.ts`                                                                                                                                                                                                                                                     |
| Port action   | Do not port syzygy. Add an assistant event ring buffer gated by `PIE_SHELL_TRACE`, and dump it on top-level assistant loop failure. Capture mode changes, PTT events, wakeword triggers, STT starts/completions/failures, injection starts/completions/failures. |
| Tests         | Env parser accepts truthy values; ring buffer truncates; failure renderer includes current assistant state and trace.                                                                                                                                            |

### P2: State-machine boundary for default assistant

| Item          | Details                                                                                                                                                                                                                                |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rust behavior | Rust has a pure `pie-core` reducer with explicit `Event`, `Effect`, `Model`, and `AssistantStage`. Illegal transitions such as PTT mode switching mid-recording are tested.                                                            |
| Rust files    | `../pie/crates/pie-core/src/app.rs`, `../pie/crates/pie-core/src/model.rs`, `../pie/crates/pie-core/src/events.rs`, `../pie/crates/pie-core/src/effects.rs`                                                                            |
| Effect gap    | Effect default assistant behavior is embedded in concurrent loops and refs inside `src/cli.ts`. It works, but runtime contracts are harder to test and reason about.                                                                   |
| Effect files  | `src/cli.ts`                                                                                                                                                                                                                           |
| Port action   | Extract a small assistant-state module only if needed for the P0/P1 capture changes. Do not build a Java-style framework. The useful target is a testable transition function for PTT/wakeword capture states.                         |
| Tests         | Port the Rust reducer cases that matter behaviorally: wakeword trigger ignored during PTT/transcribing, PTT mode cannot switch mid-recording, short/silent clips skip STT, text injection returns to listening, shutdown clears state. |

## Things not worth porting as-is

| Rust item                                                      | Reason                                                                                                                                                                          |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Multi-crate Rust workspace shape                               | TypeScript does not need this. Port behavior, not crate boundaries.                                                                                                             |
| `syzygy` runtime                                               | Useful in Rust, but copying the runtime idea wholesale into Effect would add framework weight. Extract small pure helpers instead.                                              |
| Rust's debloated CLI surface                                   | Effect's extra commands are useful operator tools. Keep them unless later evidence says they are dead.                                                                          |
| `../pie/config/commands/*.yml` and `../pie/config/config.toml` | These are tracked but not wired into current Rust command dispatch. Do not port them as runtime features without a separate command-pipeline design.                            |
| Rust text injection wholesale                                  | Effect already has stronger Wayland/X11 selection, `PIE_WAYLAND_INJECTION_MODE`, clipboard paste heuristics, and backend reporting. Only port notification/dead-input behavior. |

## Recommended migration plan

### Phase 1: Capture correctness

1. Add PCM utility module and tests.
2. Port PTT post-roll and low-signal filtering into default assistant.
3. Port auto-gain normalization into assistant capture and `record`.
4. Add dead-input detector and warning path.

Done when:

- PTT no longer cuts off trailing words on key release.
- Silent/muted PTT does not call OpenRouter.
- `record` reports source, RMS, peak, and gain.
- `bun run gate` passes.

### Phase 2: STT operator control

1. Add prompt files under `$XDG_CONFIG_HOME/pie/prompts/`.
2. Copy Rust prompt defaults.
3. Add `wakewordEnabled` config.
4. Switch non-streaming OpenRouter calls to strict schema if compatible with the Effect OpenAI client.

Done when:

- Operators can edit prompts without changing code.
- Bad prompt files fail with actionable messages.
- PTT-only mode works with `wakewordEnabled: false`.
- Structured response drift fails loudly.

### Phase 3: Wakeword training parity

1. Add `silence/` dataset support.
2. Add WAV decode and saved dataset loading.
3. Add `--capture-negatives-only` and `--train-only`.
4. Run validation and auto-tuning immediately after training.

Done when:

- A model can be retrained from saved clips without recapturing positives.
- Negatives can be appended later.
- Training writes both `<model>.json` and `detection-tuning.json`.
- A broken trained model fails before it is presented as usable.

### Phase 4: Diagnostics and state tests

1. Add `PIE_SHELL_TRACE`-style bounded event trace.
2. Extract only the assistant state helpers needed to test capture transitions.
3. Port the important Rust reducer tests as TypeScript tests.

Done when:

- A failed assistant loop prints enough state to debug without reproducing immediately.
- PTT/wakeword transition behavior is covered outside live PulseAudio/D-Bus.

## Acceptance criteria for one-to-one Rust-to-Effect parity

Effect can be considered functionally caught up with Rust when all of these are true:

- Default assistant supports wakeword + PTT with Rust-equivalent post-roll, silence gate, auto-gain, muted-input warning, and recording-state persistence.
- `stt.json` supports `wakewordEnabled` and prompt paths are bootstrapped/validated.
- OpenRouter non-streaming requests use a strict structured-output contract or an explicitly documented equivalent.
- `wakeword-train` supports persistent datasets, negative-only capture, train-only retraining, silence clips, validation, and automatic tuning.
- `record` provides Rust-level source/gain/metric reporting and `--raw`.
- Tests cover the migrated behavior without requiring live microphone, D-Bus, or OpenRouter.

## Open questions

- Should Effect keep the legacy `effect-pi` XDG directory preference after Rust parity lands? Current Effect code still does; Rust current code uses only `pie` paths.
- Should default wakeword max dictation be `45s` from Effect config defaults or `120s` from Rust runtime defaults? Pick one explicit product value before touching the config schema.
- Should strict OpenRouter JSON schema replace Effect's fallback-to-raw behavior immediately, or should this be gated behind one compatibility test against the active OpenRouter models?
