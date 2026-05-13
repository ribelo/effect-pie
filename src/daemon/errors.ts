import * as Data from "effect/Data"
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError"
import { RpcClientDefect } from "effect/unstable/rpc/RpcClientError"
import {
  SocketOpenError,
  SocketReadError,
  SocketWriteError,
  SocketCloseError,
} from "effect/unstable/socket/Socket"

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

  if (reason instanceof SocketOpenError) {
    const code: unknown = Reflect.get(reason.cause, "code")
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

  if (
    reason instanceof SocketReadError ||
    reason instanceof SocketWriteError ||
    reason instanceof SocketCloseError
  ) {
    return new DaemonClientError({
      kind: "Transport",
      message: `Socket transport error: ${error.message}`,
      cause: error,
    })
  }

  if (reason instanceof RpcClientDefect) {
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
