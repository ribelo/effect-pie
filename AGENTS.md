# Repository Guidelines

## Overview

effect-pi is a TypeScript/Effect 4.0 port of PIE (Personal Intelligence Engine) -- a voice-activated personal AI assistant for Linux with audio capture, wake-word detection, STT, and AI routing via command pipelines.

## Structure

Keep code under `src/`. Put tests next to code or in `test/`.

- `bin/pie` - CLI executable shim
- `src/cli.ts` - primary CLI entrypoint
- `src/desktop` - desktop session detection
- `src/input` - text injection backend selection
- `src/pulse` - PulseAudio protocol/client/streaming
- `src/stt` - speech-to-text configuration and OpenRouter integration
- `src/wakeword` - openWakeWord assets, ONNX pipeline, training helpers, trigger logic
- `src/wayland` - Wayland typing and global shortcut integration
- `src/x11` - X11 typing integration
- `scripts` - operator scripts run with Bun
- `assets/openwakeword` - checked-in manifests and runtime asset placeholders
- `docs` - architecture and supporting notes
- `.reference` - local reference code snapshots

## Quickshell Integration

PIE is coupled with a Quickshell status bar that displays recording state via the `PieRecording.qml` widget. Quickshell config lives in `~/.dotfiles/nixos/home/common/desktop/quickshell/` (Nix home-manager managed). Key file: `widgets/PieRecording.qml`.

## Reference Code

Use local reference code before inventing patterns from scratch.

- `../erg/` - Bun + Effect 4.0 project structure, dependency pinning, tool config, and engineering rules
- `../erg/.reference/effect-smol/` - canonical Effect v4 reference, package names, service/layer patterns, and migration guidance
- `../erg/.reference/effect-smol/MIGRATION.md` - repo-wide migration rules and naming changes to apply when examples conflict
- `../erg/.reference/effect-smol/LLMS.md` - Effect v4 LLM-oriented guidance and idiomatic patterns
- `../erg/.reference/effect-smol/migration/services.md` - Effect service/layer migration details
- `.reference/pulseaudio.js/` - local PulseAudio reference implementation

## Tech Stack

- **Runtime**: Bun
- **Framework**: Effect 4.0 (effect-smol)
- **AI**: `@effect/ai-anthropic`, `@effect/ai-openai`
- **Platform**: `@effect/platform-node`
- **Test**: `node:test` + `node:assert/strict`, executed by `bun test`

## Commands

Run from repo root:

```bash
bun install
bun run check
bun run effect:diagnostics
bun run lint
bun run format
bun run format:check
bun run test
bun run gate
```

## Quality Gate

Gate command: `bun run gate`

Gate runs: `check -> effect:diagnostics -> lint -> format:check -> test`

**Saying "Done" rule**: Before claiming work is done, run `bun run gate`. If it fails from your changes, fix it. If existing local state blocks the gate, state the exact blocker without shifting blame.

## Engineering Rules

Keep solutions boring, explicit, and easy to edit.

- No fallback logic, compatibility shims, or silent defaults.
- No upgrade/migration paths in code. Break loudly and clearly.
- Delete old paths instead of deprecating them.
- Product code should not be aware that old legacy schema/code/functionality ever existed. When a contract changes, delete the old path completely instead of adding import, cutover, fallback, compatibility, or translation logic. If stale legacy state is encountered, fail loudly and tell the operator to delete/recreate it rather than teaching the runtime how to understand it.
- Model illegal states so they cannot exist.
- Validate hard at the boundary and fail fast on bad external data.
- Never silently skip, filter, patch around, or swallow errors.
- Use structured errors and actionable logs.
- Keep new runtime paths observable: meaningful spans, structured log fields, and enough context to explain failures without reproducing them interactively.
- Avoid clever abstractions and type tricks unless they clearly reduce complexity.
- Use Effect as the control plane, not the hot loop: keep CPU-heavy inner loops as plain TypeScript, and use Effect workers when CPU-bound tasks are large enough to block the main runtime.
- Treat all repository code and any uncommitted changes you encounter as agent-owned unless the user explicitly says otherwise. Do not describe code as "not my code"; if you find existing local changes, treat them as work left by an earlier agent run and preserve them unless the user instructs otherwise.
- Treat failing tests, lint errors, typecheck failures, and broken local state as agent-owned too. Do not excuse failures as caused by "preexisting changes" or "someone else's code"; either fix the repo state, or state the exact blocker without shifting blame.

## Effect Guidance

This repository targets Effect v4 beta from `effect-smol`. Do not duplicate Effect migration notes in this file.

Before writing or normalizing Effect code, read the relevant source of truth in `../erg/.reference/effect-smol/`:

- `MIGRATION.md`
- `LLMS.md`
- `migration/services.md`

Keep the project rule simple: follow the reference completely, or do not start the pattern change.

## Style

- 2-space indentation
- `camelCase` for values/functions
- `PascalCase` for types, schemas, services
- `kebab-case` for files unless existing project conventions require otherwise
- Root configs stay authoritative
- Prefer small, focused modules
- No comments unless code is genuinely complex; comments explain why, not what

## Testing

- Test positive and negative paths with similar rigor.
- Add regression tests before fixing bugs.
- Keep observability strong as features evolve.
- Strategic coverage on domain logic and boundaries.
- Tests live alongside implementation or in `test/`.
- No mocks unless absolutely necessary.
- Every completed code change must pass `bun run gate`.

## Issue Tracking

Uses beads (`bd`) for task tracking.

### Definition of Ready (DoR)

- Clear acceptance criteria
- Dependencies identified
- Sized to a few hours of work

### Definition of Done (DoD)

- Code compiles and passes gate
- Tests cover the change
- Beads issue updated/closed

## Workflow

- Use durable task tracking for substantial work only.
- A tracked task is a multi-step change, a behavior change, work likely to span more than one turn or session, work with meaningful review or follow-up, or anything large enough that losing state would hurt.
- Do not track trivial edits: typos, one-line docs/config changes, formatting-only changes, tiny mechanical fixes, or other work that is faster to do than to track.
- If unsure, skip task tracking and do the change. Prefer under-tracking to wasting time on micro-tracking.
- Keep durable architecture rationale in `docs/architecture.md`, not only in tasks or chat history.

## Git

Use short imperative commits, preferably Conventional Commits, for example `feat: add wakeword asset validation`.

When ending a work session:

1. File issues for follow-up work.
2. Run `bun run gate`.
3. Update beads status.
4. `git pull --rebase && bd sync && git push`.
5. Verify `git status` is up to date with origin.

Work is not complete until push succeeds. Do not leave finished work stranded locally.

Commit rules:

- Conventional commits: `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`
- Imperative mood, single-purpose commits
- Never `git add -A`
- Never add Claude as co-author
