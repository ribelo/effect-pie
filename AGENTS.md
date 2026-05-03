# Repository Guidelines

## Overview

effect-pi is a TypeScript/Effect 4.0 port of PIE (Personal Intelligence Engine) -- a voice-activated personal AI assistant for Linux with audio capture, wake-word detection, and AI routing via command pipelines.

## Quickshell Integration

PIE is coupled with a Quickshell status bar that displays recording state via the `PieRecording.qml` widget. Quickshell config lives in `~/.dotfiles/nixos/home/common/desktop/quickshell/` (Nix home-manager managed). Key file: `widgets/PieRecording.qml`.

## Reference Code

- **Effect 4.0 patterns**: `../erg/` (effect-smol dependency pinning, project structure, tooling)

## Tech Stack

- **Runtime**: Bun
- **Framework**: Effect 4.0 (effect-smol)
- **AI**: `@effect/ai-anthropic`, `@effect/ai-openai`
- **Platform**: `@effect/platform-node`
- **Test**: `node:test` + `node:assert/strict`

## Build, Test, and Development Commands

```bash
bun install          # Install dependencies
bun run check        # TypeScript typecheck (tsgo)
bun run lint         # Lint (oxlint)
bun run format:check # Format check (oxfmt)
bun run test         # Run tests
bun run gate         # Full quality gate (must pass before push)
```

## Quality Gate

Gate command: `bun run gate`

Gate runs: `check -> effect:diagnostics -> lint -> format:check -> test`

**Saying "Done" rule**: Before claiming work is done, run `bun run gate`. If it fails from your changes, fix it. If pre-existing, stop and ask.

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

## Coding Style

- Effect 4.0 idioms (generators, services, layers)
- `camelCase` for functions/variables, `PascalCase` for types/services
- Prefer small, focused modules
- No comments unless code is genuinely complex

## Commit Guidelines

- Conventional commits: `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`
- Imperative mood, single-purpose commits
- Never `git add -A`
- Never add Claude as co-author

## Testing

- Strategic coverage on domain logic and boundaries
- Tests alongside implementation
- `node:test` + `node:assert/strict` for execution
- No mocks unless absolutely necessary

## Landing the Plane

1. Run `bun run gate`
2. Update beads issues
3. `git pull --rebase && bd sync && git push`
4. Verify pushed
