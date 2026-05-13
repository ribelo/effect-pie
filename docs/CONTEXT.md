# Domain Glossary

This file pins architectural terms introduced by codebase deepenings. Update it whenever a new module or contract enters the vocabulary.

## PTT loop

The state-machine-driven consumer of keyboard events that opens a per-hold PulseAudio capture, manages post-roll, and dispatches the captured clip via a handle. Lives in `src/ptt/loop.ts`. Single `runPttLoop` implementation is shared by `src/commands/ptt.ts` and `src/commands/assistant/pttLoop.ts`.

## PTT capture handle

The `{ offer, finish, cancel }` contract the loop hands to each hold. Adapters wrap it with coordinator methods (`tryStart`/`stop`), diagnostics, or `pttActiveRef` writes. Implementations live in `src/ptt/handles.ts`: `makeStreamedSttHandle` for transcribe/translate flows, `makeWavClipHandle` for the standalone `pie ptt` command.

## Recording coordinator

Context.Service in `src/commands/assistant/coordinator.ts`. Owns exclusive recording mode ownership, the enabled flag, and the runtime JSON at `ASSISTANT_RECORDING_STATE_PATH` used by the Quickshell widget. Methods: `snapshot`, `tryStart`, `stop`, `setEnabled`, `toggleEnabled` (atomic), `toggleMeeting` (atomic), `setError`, `clear`. Provided at assistant scope in `src/commands/assistant.ts`, not in the root `runtimeLayer`.
