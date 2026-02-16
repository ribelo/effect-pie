# Decisions

## Technology

| Decision | Rationale |
|----------|-----------|
| Effect 4.0 (effect-smol) | Matches erg project; structured concurrency, services, layers for daemon architecture |
| Bun runtime | Fast startup, native TS, good for CLI/daemon |
| oxlint + oxfmt | Fast linting/formatting, matches erg tooling |
| tsgo | Fast typecheck, matches erg tooling |

## Scope

| Decision | Rationale |
|----------|-----------|
| Port of PIE (Rust) | Same feature set -- audio capture, wake word, AI routing, command pipelines |
| CLI/daemon architecture | Same as original -- `effect-pi daemon`, `effect-pi run <name>`, etc. |

## Open Questions

- Audio capture strategy in Bun/Node (PulseAudio bindings vs FFI vs subprocess)
- Wake word detection approach (Picovoice FFI or alternative)
- Keyboard injection for Wayland from JS/TS
