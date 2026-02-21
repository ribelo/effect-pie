import { BunRuntime } from "@effect/platform-bun";
import { Effect } from "effect";

const main = Effect.log("effect-pi");

main.pipe(BunRuntime.runMain);
