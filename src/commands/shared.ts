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
      () => `--${name} must be greater than 0`,
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

export const makePttClipPath = (outputDir: string): string => {
  const now = new Date()
  const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
    now.getDate(),
  ).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}-${String(
    now.getMinutes(),
  ).padStart(2, "0")}-${String(now.getSeconds()).padStart(2, "0")}-${String(
    now.getMilliseconds(),
  ).padStart(3, "0")}`

  return path.join(outputDir, `ptt-${stamp}.wav`)
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
    return sorted[lower] ?? 0
  }

  const lowerValue = sorted[lower] ?? 0
  const upperValue = sorted[upper] ?? 0
  const weight = position - lower

  return lowerValue * (1 - weight) + upperValue * weight
}

export const drainPendingStdin = Effect.sync(() => {
  if (!process.stdin.readable) {
    return
  }

  try {
    while (process.stdin.read() !== null) {}
  } catch {
    // best-effort stdin drain to avoid replaying injected text into readline prompts
  }
})

export const waitForEnter = (message: string): Effect.Effect<void, CliError> =>
  Effect.promise(async () => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    })
    try {
      await rl.question(`${message}\n`)
    } finally {
      rl.close()
    }
  }).pipe(
    Effect.mapError(
      (cause) =>
        new CliError({
          message: `Failed to read terminal input for prompt: ${message}`,
          cause,
        }),
    ),
  )
