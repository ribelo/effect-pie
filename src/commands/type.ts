import { Console, Effect } from "effect"
import { Command, Flag } from "effect/unstable/cli"
import { typeTextInFocusedApp } from "../input/textInjection.js"

export const typeCommand = Command.make(
  "type",
  {
    text: Flag.string("text").pipe(Flag.withDescription("Text to type into the focused app")),
  },
  (config) =>
    Effect.gen(function* () {
      const result = yield* typeTextInFocusedApp(config.text)
      yield* Console.log(
        `Typed ${result.text.length} characters with ${result.backend} (${result.sessionType})`,
      )
    }),
).pipe(Command.withDescription("Spike command that types text via wtype/xdotool based on session"))
