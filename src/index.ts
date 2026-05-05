import { BunRuntime } from "@effect/platform-bun"
import { Effect } from "effect"

export { rootCommand } from "./cli.js"

const main = Effect.log("pie")

BunRuntime.runMain(main)
