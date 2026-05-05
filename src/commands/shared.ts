import { Data, Effect, Option } from "effect"
import { Flag } from "effect/unstable/cli"
import * as path from "node:path"
import { createInterface } from "node:readline/promises"

export const positiveIntegerFlag = (name: string, description: string, defaultValue: number) =>
  Flag.integer(name).pipe(
    Flag.withDescription(description),
    Flag.withDefault(defaultValue),
    Flag.filter(
      (value) => value > 0,
      () => "must be greater than 0",
    ),
  )

export const boundedFloatFlag = (
  name: string,
  description: string,
  defaultValue: number,
  min: number,
  max: number,
) =>
  Flag.float(name).pipe(
    Flag.withDescription(description),
    Flag.withDefault(defaultValue),
    Flag.filter(
      (value) => value >= min && value <= max,
      () => `--${name} must be between ${min} and ${max}`,
    ),
  )

export const optionalPositiveIntegerFlag = (name: string, description: string) =>
  Flag.integer(name).pipe(
    Flag.optional,
    Flag.withDescription(description),
    Flag.filter(
      (value) => Option.isNone(value) || value.value > 0,
      () => `--${name} must be greater than 0`,
    ),
  )

export const optionalBoundedFloatFlag = (
  name: string,
  description: string,
  min: number,
  max: number,
) =>
  Flag.float(name).pipe(
    Flag.optional,
    Flag.withDescription(description),
    Flag.filter(
      (value) => Option.isNone(value) || (value.value >= min && value.value <= max),
      () => `--${name} must be between ${min} and ${max}`,
    ),
  )

export const optionalSourceFlag = Flag.string("source").pipe(
  Flag.optional,
  Flag.withDescription("PulseAudio source name (run `pie sources` to list)"),
)

export const concatChunks = (chunks: ReadonlyArray<Uint8Array>): Uint8Array => {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const out = new Uint8Array(total)

  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }

  return out
}

const formatTimestamp = (date: Date): string => {
  return date.toISOString().replace("T", "_").replace(/:/g, "-").replace(".", "-").slice(0, 23)
}

export const makePttClipPath = (outputDir: string): string => {
  return path.join(outputDir, `ptt-${formatTimestamp(new Date())}.wav`)
}

export class NoSpeechDetectedError extends Data.TaggedError("NoSpeechDetectedError")<{
  readonly message: string
  readonly observedMaxRms: number
  readonly threshold: number
}> {}

export class CliError extends Data.TaggedError("CliError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

export const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value))

export const percentile = (values: ReadonlyArray<number>, rank: number): number => {
  if (values.length === 0) {
    return 0
  }

  const sorted = [...values].sort((left, right) => left - right)
  const normalizedRank = clamp(rank, 0, 1)
  const position = normalizedRank * (sorted.length - 1)
  const lower = Math.floor(position)
  const upper = Math.ceil(position)

  if (lower === upper) {
    return sorted[lower]!
  }

  const lowerValue = sorted[lower]!
  const upperValue = sorted[upper]!
  const weight = position - lower

  return lowerValue * (1 - weight) + upperValue * weight
}

export const drainPendingStdin = Effect.sync(() => {
  if (!process.stdin.readable) {
    return
  }

  try {
    while (process.stdin.read() !== null) {}
  } catch (cause) {
    Effect.runFork(Effect.logWarning("Failed to drain stdin").pipe(Effect.annotateLogs({ cause })))
  }
})

export const waitForEnter = Effect.fn("pie/commands/shared.waitForEnter")(function* (
  message: string,
): Effect.fn.Return<void, CliError> {
  return yield* Effect.callback<void, CliError>((resume) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    })

    rl.question(`${message}\n`)
      .then(() => {
        resume(Effect.void)
      })
      .catch((cause: unknown) => {
        resume(
          Effect.fail(
            new CliError({
              message: `Failed to read terminal input for prompt: ${message}`,
              cause,
            }),
          ),
        )
      })

    return Effect.sync(() => rl.close())
  })
})
