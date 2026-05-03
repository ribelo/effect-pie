import { NodeRuntime } from "@effect/platform-node"
import { Effect } from "effect"

const main = Effect.log("pie")

main.pipe(NodeRuntime.runMain)
