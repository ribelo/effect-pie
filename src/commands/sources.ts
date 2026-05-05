import { Console, Effect } from "effect"
import { Command } from "effect/unstable/cli"
import { PulseAudioClient } from "../pulse/client.js"

export const sourcesCommand = Command.make("sources", {}, () =>
  Effect.gen(function* () {
    const client = yield* PulseAudioClient

    const serverInfo = yield* client.getServerInfo
    const sources = yield* client.listSources

    yield* Console.log(`Default source: ${serverInfo.defaultSource}`)
    yield* Console.log(`Available sources (${sources.length}):`)

    for (const source of sources) {
      const marker = source.name === serverInfo.defaultSource ? "*" : " "
      const name = source.name ?? "<unnamed>"
      const description = source.description ?? "<no description>"
      yield* Console.log(
        `${marker} index=${source.index} name=${name} desc=${description} rate=${source.sampleSpec.rate} channels=${source.sampleSpec.channels}`,
      )
    }

    yield* Console.log(
      "Use --source <name> with record/wakeword/wakeword-train to pin input source",
    )
  }),
).pipe(Command.withDescription("List PulseAudio capture sources and default source"))
