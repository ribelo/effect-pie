# Architecture

## Purpose

effect-pi is a TypeScript/Effect 4.0 port of PIE (Personal Intelligence Engine). It provides voice-activated command execution on Linux through audio capture, wake-word detection, and AI-powered command routing.

## Directory Structure

```
effect-pi/
├── src/              # Source code
│   └── index.ts      # Entry point
├── test/             # Tests
├── docs/             # Documentation
│   ├── architecture.md
│   └── qa.md
├── AGENTS.md         # AI workflow guidelines
├── package.json
├── tsconfig.json
└── tsconfig.check.json
```

## Core Components (planned)

- **Daemon** -- Long-running process managing audio and pipelines
- **Audio Capture** -- PulseAudio/PipeWire integration for mic and system audio
- **Wake Word** -- Hotword detection triggering command capture
- **AI Router** -- Intent classification and command dispatch via Effect AI
- **Command Pipelines** -- YAML-defined stage pipelines for processing
- **Keyboard Output** -- Text injection into focused applications

## Data Flow

```
Audio Input -> Wake Word Detection -> Audio Capture -> STT -> AI Router -> Command Pipeline -> Output
```
