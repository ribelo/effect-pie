import * as Data from "effect/Data"
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError"

export class SocketPreflightError extends Data.TaggedError("SocketPreflightError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

export class DaemonClientError extends Data.TaggedError("DaemonClientError")<{
  readonly kind: "NotRunning" | "Transport" | "Protocol"
  readonly message: string
  readonly cause?: unknown
}> {}

/**
 * Collapse RpcClientError into one of three DaemonClientError kinds.
 *
 * Mapping table:
 * - SocketOpenError with nested code ENOENT or ECONNREFUSED -> NotRunning
 * - SocketOpenError (other), SocketReadError, SocketWriteError, SocketCloseError -> Transport
 * - RpcClientDefect, schema-decode failures, anything else -> Protocol
 */
export const classifyRpcClientError = (error: RpcClientError): DaemonClientError => {
  const reason = error.reason
  const tag: unknown =
    typeof reason === "object" && reason !== null ? Reflect.get(reason, "_tag") : undefined

  if (tag === "SocketOpenError") {
    const code: unknown =
      typeof reason.cause === "object" && reason.cause !== null
        ? Reflect.get(reason.cause, "code")
        : undefined
    if (code === "ENOENT" || code === "ECONNREFUSED") {
      return new DaemonClientError({
        kind: "NotRunning",
        message: "Daemon is not running",
      })
    }
    return new DaemonClientError({
      kind: "Transport",
      message: `Socket open failed: ${error.message}`,
      cause: error,
    })
  }

  if (tag === "SocketReadError" || tag === "SocketWriteError" || tag === "SocketCloseError") {
    return new DaemonClientError({
      kind: "Transport",
      message: `Socket transport error: ${error.message}`,
      cause: error,
    })
  }

  if (tag === "RpcClientDefect") {
    return new DaemonClientError({
      kind: "Protocol",
      message: `RPC protocol defect: ${error.message}`,
      cause: error,
    })
  }

  return new DaemonClientError({
    kind: "Protocol",
    message: `RPC protocol error: ${error.message}`,
    cause: error,
  })
}
