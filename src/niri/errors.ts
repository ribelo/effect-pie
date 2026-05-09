import { Data } from "effect"

export class NiriUnavailableError extends Data.TaggedError("NiriUnavailableError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

export class NiriIpcError extends Data.TaggedError("NiriIpcError")<{
  readonly message: string
  readonly stderr?: string
  readonly exitCode?: number
  readonly cause?: unknown
}> {}

export class NiriTimeoutError extends Data.TaggedError("NiriTimeoutError")<{
  readonly message: string
  readonly timeoutMs: number
  readonly cause?: unknown
}> {}

export class NiriDecodeError extends Data.TaggedError("NiriDecodeError")<{
  readonly message: string
  readonly payload: string
  readonly cause?: unknown
}> {}

export class NiriValidationError extends Data.TaggedError("NiriValidationError")<{
  readonly message: string
}> {}

export type NiriError =
  | NiriUnavailableError
  | NiriIpcError
  | NiriTimeoutError
  | NiriDecodeError
  | NiriValidationError
