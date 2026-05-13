# Domain Glossary

This file pins architectural terms introduced by codebase deepenings. Update it whenever a new module or contract enters the vocabulary.

## PTT loop

The state-machine-driven consumer of keyboard events that opens a per-hold PulseAudio capture, manages post-roll, and dispatches the captured clip via a handle. Lives in `src/ptt/loop.ts`. Single `runPttLoop` implementation is shared by `src/commands/ptt.ts` and `src/commands/assistant/pttLoop.ts`.

## PTT capture handle

The `{ offer, finish, cancel }` contract the loop hands to each hold. Adapters wrap it with coordinator methods (`tryStart`/`stop`), diagnostics, or `pttActiveRef` writes. Implementations live in `src/ptt/handles.ts`: `makeStreamedSttHandle` for transcribe/translate flows, `makeWavClipHandle` for the standalone `pie ptt` command.

## Recording coordinator

Context.Service in `src/commands/assistant/coordinator.ts`. Owns exclusive recording mode ownership, the enabled flag, and the runtime JSON at `ASSISTANT_RECORDING_STATE_PATH` used by the Quickshell widget. Methods: `snapshot`, `tryStart`, `stop`, `setEnabled`, `toggleEnabled` (atomic), `toggleMeeting` (atomic), `setError`, `clear`. Provided at assistant scope in `src/commands/assistant.ts`, not in the root `runtimeLayer`.

## Streamed STT dispatch

The seam between a PCM chunk producer and a streaming STT+injection pipeline. One audio queue, one forked transcription fiber, three verbs `offer`/`finish`/`cancel`. Provider-neutral. Implemented by `src/stt/streamedDispatch.ts::makeStreamedSttDispatch`. Used by `src/ptt/handles.ts::makeStreamedSttHandle` and `src/commands/assistant/wakewordLoop.ts`.

## Streaming error classification

The decision of whether a streamed STT failure is STT-side (provider, auth, context) or injection-side (`wtype`/`xdotool`). Driven by tagged-error `_tag` prefixes: `OpenRouterSttError`, `CodexRealtimeSttError`, `CodexAuthError`, `SttDispatchError`, and any `Niri*` error classify as STT-side; everything else classifies as injection-side. Callers use `classifyStreamingError(cause, prefix)` from `src/stt/streamedDispatch.ts` to turn raw dispatch errors into their own error domain with a single message line.

## Daemon RPC contract

The `effect/unstable/rpc` group in `src/daemon/contract.ts` that types the CLI-to-daemon conversation. Seven parameterless RPCs mirror the pie CLI verbs: `Status` (returns `RecordingSnapshot`), `Pause` / `Resume` / `Toggle` (return void / void / boolean), `MeetingStart` (returns `{ result: StartResult, snapshot: RecordingSnapshot }`), `MeetingStop` / `MeetingToggle` (return `RecordingSnapshot`). Domain schemas (`RecordingSnapshot`, `StartResult`, `RecordingMode`) live alongside the coordinator in `src/commands/assistant/coordinator.ts`; the contract imports them. Transport is NDJSON over the unix socket at `$XDG_RUNTIME_DIR/pie/control.sock`. Server implementation in `src/daemon/server.ts` (handler layer + `BunSocketServer.layer`); client adapter in `src/daemon/client.ts`.

## Daemon client

The `DaemonClient` Context.Service in `src/daemon/client.ts` exposes one typed method per RPC. All methods collapse transport errors into `DaemonClientError` with one of three kinds: `NotRunning` (socket missing or refused), `Transport` (socket read/write/close failure), `Protocol` (schema decode defect or RPC library defect). The CLI output convention is: `NotRunning` -> print `off` to stdout and exit 0; `Transport`/`Protocol` -> print to stderr and exit 1; `toggle` additionally calls `notifyWarning` on `NotRunning`. `DaemonClient.layer` is provided only on the seven daemon-facing CLI commands in `src/commands/daemon.ts` so that `pie sources`, `pie ptt`, `pie wakeword`, etc. never open the socket.

## Niri IPC

The `Niri` Context.Service in `src/niri/niri.ts` is the single boundary for Niri compositor interaction. `Niri.live({ niriPath?, timeoutMs?, runner? })` builds the service; when `runner` is supplied (test path), niri-path resolution is skipped. Pure command builders and validators live in `src/niri/commands.ts` (`buildNiriReadCommand`, `buildNiriActionCommand`, `buildNiriOutputCommand`, `workspaceReferenceArg`, `sizeChangeArg`). The `CommandRunner` seam (`{ run, streamLines }`) lets tests inject fake subprocess behaviour without a `Context.Service` for the runner. There is no `NiriTransport` service; the old transport/service split was collapsed into one module.

## STT provider selection

`SttService.live(config)` in `src/stt/service.ts` is the only product-facing entrypoint; it dispatches to `codexSttLayer(config)` or `openRouterSttLayer(config)` based on `config.provider`. The Codex layer (`src/stt/codexLayer.ts`) wraps `CodexRealtimeSttService` and handles stream-to-stream passthrough; the conversation-model collect-first quirk lives inside `CodexRealtimeSttService.translate` (`src/stt/codexRealtimeService.ts`). The OpenRouter layer (`src/stt/openRouterLayer.ts`) owns the stream-to-clip shim (`Stream.runCollect` + `concatAudioChunks`) because `OpenRouterSttService` is clip-only. `SttDispatchError` and the `SttService.provider` field were deleted; there is no provider surface on the service interface.
