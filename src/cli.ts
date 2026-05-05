import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Effect, Layer } from "effect"
import { Command, Flag } from "effect/unstable/cli"

import { PulseAudioClient } from "./pulse/client.js"
import { layer as keyboardLayer } from "./keyboard/monitor.js"

import { sourcesCommand } from "./commands/sources.js"
import { meterCommand } from "./commands/meter.js"
import { recordCommand } from "./commands/record.js"
import {
  pttPortalCommand,
  pttCommand,
  pttTranscribeCommand,
  pttTranslateCommand,
} from "./commands/ptt.js"
import { sttInteractiveCommand } from "./commands/sttInteractive.js"
import { typeCommand } from "./commands/type.js"
import { wakewordCommand } from "./commands/wakeword.js"
import { wakewordTuneCommand } from "./commands/wakewordTune.js"
import { wakewordTrainCommand } from "./commands/wakewordTrain.js"
import { runAssistantDefaultCommand } from "./commands/assistant.js"

export const rootCommand = Command.make(
  "pie",
  {
    "ptt-transcribe-keysym": Flag.integer("ptt-transcribe-keysym").pipe(
      Flag.optional,
      Flag.withDescription("XKB keysym for PTT transcribe (default: 65478)"),
    ),
    "ptt-translate-keysym": Flag.integer("ptt-translate-keysym").pipe(
      Flag.optional,
      Flag.withDescription("XKB keysym for PTT translate (default: 65479)"),
    ),
  },
  (config) => runAssistantDefaultCommand(config),
).pipe(
  Command.withDescription(
    "pie voice assistant (run without subcommands for combined wakeword + PTT mode)",
  ),
  Command.withSubcommands([
    recordCommand,
    sourcesCommand,
    meterCommand,
    pttPortalCommand,
    pttCommand,
    pttTranscribeCommand,
    pttTranslateCommand,
    sttInteractiveCommand,
    typeCommand,
    wakewordCommand,
    wakewordTuneCommand,
    wakewordTrainCommand,
  ]),
)

const runtimeLayer = Layer.mergeAll(BunServices.layer, PulseAudioClient.layer(), keyboardLayer)

const main = Command.run(rootCommand, { version: "0.1.0" }).pipe(Effect.provide(runtimeLayer))

BunRuntime.runMain(main)
