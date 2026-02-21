import { BunRuntime } from "@effect/platform-bun";
import { Effect } from "effect";

const main = Effect.log("pie");

main.pipe(BunRuntime.runMain);
