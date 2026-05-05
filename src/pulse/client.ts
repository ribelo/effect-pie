import * as NodeSocket from "@effect/platform-node/NodeSocket"
import * as Data from "effect/Data"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Queue from "effect/Queue"
import * as Ref from "effect/Ref"
import * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import * as Context from "effect/Context"
import type * as Socket from "effect/unstable/socket/Socket"
import { promises as fs } from "node:fs"

import {
  buildAuthCommand,
  buildCreateRecordStreamCommand,
  buildDeleteRecordStreamCommand,
  buildGetServerInfoCommand,
  buildGetSourceListCommand,
  buildSetClientNameCommand,
  parseAuthResponse,
  parseCommandEnvelope,
  parseCreateRecordStreamResponse,
  parseErrorCode,
  parseProtocolCompatibility,
  parseServerInfoResponse,
  parseSetClientNameResponse,
  parseSourceListResponse,
  type CommandPacket,
} from "./commands.js"
import {
  PA_COMMAND,
  PA_DEFAULT_COOKIE_PATH,
  PA_DEFAULT_SOCKET_PATH,
  PA_NATIVE_PROTOCOL_VERSION,
  PA_NO_INDEX,
  PA_STREAM_DESCRIPTOR_SIZE,
  type RecordStreamInfo,
  type RecordStreamOptions,
  type ServerInfo,
  type SourceInfo,
} from "./defs.js"
import { concatBytes, decodePacketHeader } from "./protocol.js"

export class PulseAudioClientError extends Data.TaggedError("PulseAudioClientError")<{
  readonly message: string
  readonly code?: number
  readonly cause?: unknown
}> {}

export class PulseAudioAuthError extends Data.TaggedError("PulseAudioAuthError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

export type ConnectOptions = {
  readonly socketPath?: string
  readonly cookie?: Uint8Array
  readonly clientName?: string
  readonly protocolVersion?: number
}

export type PulseAudioClientConfig = {
  readonly socketPath?: string
  readonly clientName?: string
  readonly protocolVersion?: number
  readonly requestTimeoutMs?: number
}

export type OpenRecordStream = {
  readonly info: RecordStreamInfo
  readonly queue: Queue.Queue<Uint8Array>
}

type Pending = Deferred.Deferred<Uint8Array, PulseAudioClientError>

type Connection = {
  scope: Scope.Closeable
  writer: (
    chunk: Uint8Array | string | Socket.CloseEvent,
  ) => Effect.Effect<void, Socket.SocketError>
  pending: Map<number, Pending>
  recordQueues: Map<number, Queue.Queue<Uint8Array>>
  socketPath: string
  requestTimeoutMs: number
  protocolVersion: number
  remainder: Uint8Array
}

const defaultRequestTimeoutMs = 15_000

const isErrnoException = (cause: unknown): cause is NodeJS.ErrnoException =>
  typeof cause === "object" && cause !== null && "code" in cause

const loadCookie = Effect.tryPromise({
  try: () => fs.readFile(PA_DEFAULT_COOKIE_PATH),
  catch: (cause) =>
    isErrnoException(cause) && cause.code === "ENOENT"
      ? new PulseAudioAuthError({
          message:
            `PulseAudio authentication cookie not found at ${PA_DEFAULT_COOKIE_PATH}. ` +
            "Ensure PulseAudio is running (pulseaudio --start) or set PULSE_COOKIE.",
          cause,
        })
      : new PulseAudioAuthError({
          message: "Failed to load PulseAudio authentication cookie",
          cause,
        }),
})

const failPendingUnsafe = (connection: Connection, error: PulseAudioClientError): void => {
  for (const pending of connection.pending.values()) {
    Deferred.doneUnsafe(pending, Effect.fail(error))
  }
  connection.pending.clear()
}

const processCommandPacket = (connection: Connection, payload: Uint8Array): void => {
  const envelope = parseCommandEnvelope(payload)
  const pending = connection.pending.get(envelope.tag)
  if (!pending) {
    return
  }

  connection.pending.delete(envelope.tag)

  switch (envelope.type) {
    case PA_COMMAND.REPLY: {
      Deferred.doneUnsafe(pending, Effect.succeed(envelope.body))
      return
    }
    case PA_COMMAND.ERROR: {
      const code = parseErrorCode(envelope.body)
      const error =
        code === null
          ? new PulseAudioClientError({ message: "PulseAudio command failed" })
          : new PulseAudioClientError({ message: "PulseAudio command failed", code })

      Deferred.doneUnsafe(pending, Effect.fail(error))
      return
    }
    default: {
      Deferred.doneUnsafe(
        pending,
        Effect.fail(
          new PulseAudioClientError({
            message: `unsupported PulseAudio response type: ${envelope.type}`,
          }),
        ),
      )
    }
  }
}

export const processIncomingChunk = (connection: Connection, chunk: Uint8Array): void => {
  let buffer = concatBytes([connection.remainder, chunk])
  let offset = 0

  while (buffer.length - offset >= PA_STREAM_DESCRIPTOR_SIZE) {
    const headerBytes = buffer.subarray(offset, offset + PA_STREAM_DESCRIPTOR_SIZE)
    const header = decodePacketHeader(headerBytes)

    const MAX_PACKET_LENGTH = 256 * 1024
    if (header.length > MAX_PACKET_LENGTH) {
      throw new PulseAudioClientError({
        message: `packet length ${header.length} exceeds max`,
      })
    }

    const packetLength = PA_STREAM_DESCRIPTOR_SIZE + header.length

    if (buffer.length - offset < packetLength) {
      break
    }

    const payload = buffer.slice(offset + PA_STREAM_DESCRIPTOR_SIZE, offset + packetLength)

    if (header.channel === PA_NO_INDEX) {
      processCommandPacket(connection, payload)
    } else {
      const queue = connection.recordQueues.get(header.channel)
      if (queue) {
        Queue.offerUnsafe(queue, payload)
      }
    }

    offset += packetLength
  }

  connection.remainder = offset === 0 ? buffer : buffer.slice(offset)
}

const shutdownRecordQueues = (connection: Connection): Effect.Effect<void> =>
  Effect.forEach(connection.recordQueues.values(), (queue) => Queue.shutdown(queue), {
    discard: true,
    concurrency: "unbounded",
  }).pipe(
    Effect.andThen(
      Effect.sync(() => {
        connection.recordQueues.clear()
      }),
    ),
  )

export class PulseAudioClient extends Context.Service<
  PulseAudioClient,
  {
    readonly getServerInfo: Effect.Effect<ServerInfo, PulseAudioClientError>
    readonly listSources: Effect.Effect<ReadonlyArray<SourceInfo>, PulseAudioClientError>
    readonly openRecordStream: (
      options?: Partial<RecordStreamOptions>,
    ) => Effect.Effect<OpenRecordStream, PulseAudioClientError>
    readonly closeRecordStream: (streamIndex: number) => Effect.Effect<void, PulseAudioClientError>
  }
>()("pie/pulse/PulseAudioClient") {
  static readonly layer = (config: PulseAudioClientConfig = {}): Layer.Layer<PulseAudioClient> =>
    Layer.effect(PulseAudioClient)(make(config))
}

const makeConnection = (
  stateRef: Ref.Ref<Connection | null>,
  defaults: PulseAudioClientConfig,
  options?: ConnectOptions,
): Effect.Effect<Connection, PulseAudioClientError> =>
  Effect.gen(function* () {
    const scope = yield* Scope.make()
    const socketPath = options?.socketPath ?? defaults.socketPath ?? PA_DEFAULT_SOCKET_PATH
    const requestTimeoutMs = defaults.requestTimeoutMs ?? defaultRequestTimeoutMs

    const connection = yield* Effect.gen(function* () {
      const socket = yield* NodeSocket.makeNet({ path: socketPath }).pipe(
        Scope.provide(scope),
        Effect.mapError(
          (cause) =>
            new PulseAudioClientError({
              message: `failed to connect to PulseAudio socket at ${socketPath}`,
              cause,
            }),
        ),
      )

      const writer = yield* socket.writer.pipe(Scope.provide(scope))

      const connection: Connection = {
        scope,
        writer,
        pending: new Map(),
        recordQueues: new Map(),
        socketPath,
        requestTimeoutMs,
        protocolVersion: 0,
        remainder: new Uint8Array(),
      }

      yield* socket
        .run((chunk) => Effect.sync(() => processIncomingChunk(connection, chunk)))
        .pipe(
          Scope.provide(scope),
          Effect.ensuring(
            Effect.gen(function* () {
              const disconnected = new PulseAudioClientError({
                message: "PulseAudio connection closed",
              })
              failPendingUnsafe(connection, disconnected)
              yield* shutdownRecordQueues(connection)
              yield* Ref.update(stateRef, (current) => (current === connection ? null : current))
            }),
          ),
          Effect.forkIn(scope),
        )

      return connection
    }).pipe(
      Effect.onExit((exit) => (Exit.isFailure(exit) ? Scope.close(scope, exit) : Effect.void)),
    )

    return connection
  })

export const awaitReply = Effect.fn("pie/pulse/PulseAudioClient.awaitReply")(function* (
  connection: Connection,
  packet: CommandPacket,
): Effect.fn.Return<Uint8Array, PulseAudioClientError> {
  const pending = yield* Deferred.make<Uint8Array, PulseAudioClientError>()
  connection.pending.set(packet.tag, pending)

  const writeResult = yield* connection.writer(packet.bytes).pipe(Effect.exit)
  if (Exit.isFailure(writeResult)) {
    connection.pending.delete(packet.tag)
    return yield* new PulseAudioClientError({
      message: "failed to send command to PulseAudio",
      cause: writeResult.cause,
    })
  }

  return yield* Deferred.await(pending).pipe(
    Effect.timeoutOrElse({
      duration: `${connection.requestTimeoutMs} millis`,
      orElse: () =>
        Effect.fail(
          new PulseAudioClientError({
            message: `timed out waiting for PulseAudio response to tag ${packet.tag}`,
          }),
        ),
    }),
    Effect.onExit(() =>
      Effect.sync(() => {
        connection.pending.delete(packet.tag)
      }),
    ),
  )
})

const make = (defaults: PulseAudioClientConfig) =>
  Effect.gen(function* () {
    const stateRef = yield* Ref.make<Connection | null>(null)

    const disconnectCurrent = Effect.gen(function* () {
      const current = yield* Ref.get(stateRef)
      if (current === null) {
        return
      }

      failPendingUnsafe(
        current,
        new PulseAudioClientError({ message: "PulseAudio connection closed by client" }),
      )
      yield* shutdownRecordQueues(current)
      yield* Scope.close(current.scope, Exit.void)
      yield* Ref.set(stateRef, null)
    })

    const getConnection = Effect.flatMap(Ref.get(stateRef), (current) =>
      current === null
        ? Effect.fail(new PulseAudioClientError({ message: "PulseAudio client is not connected" }))
        : Effect.succeed(current),
    )

    const invoke = <A>(
      packet: CommandPacket,
      parser: (payload: Uint8Array) => A,
    ): Effect.Effect<A, PulseAudioClientError> =>
      Effect.gen(function* () {
        const connection = yield* getConnection
        const payload = yield* awaitReply(connection, packet)

        const parsed = yield* Effect.try({
          try: () => parser(payload),
          catch: (cause) =>
            new PulseAudioClientError({
              message: "failed to parse PulseAudio response",
              cause,
            }),
        })

        return parsed
      })

    const connectSemaphore = yield* Semaphore.make(1)

    const connect = (options?: ConnectOptions): Effect.Effect<void, PulseAudioClientError> =>
      connectSemaphore.withPermits(1)(
        Effect.gen(function* () {
          const existing = yield* Ref.get(stateRef)
          if (existing !== null) {
            return
          }

          lastConnectOptions = options
          const connection = yield* makeConnection(stateRef, defaults, options)
          yield* Ref.set(stateRef, connection)

          const protocolVersion =
            options?.protocolVersion ?? defaults.protocolVersion ?? PA_NATIVE_PROTOCOL_VERSION

          const cookie =
            options?.cookie ??
            (yield* loadCookie.pipe(
              Effect.mapError(
                (cause) =>
                  new PulseAudioClientError({
                    message: cause.message,
                    cause,
                  }),
              ),
            ))

          const authPacket = yield* buildAuthCommand(cookie, protocolVersion).pipe(
            Effect.fromResult,
            Effect.mapError(
              (message) =>
                new PulseAudioClientError({
                  message: `failed to build auth command: ${message}`,
                }),
            ),
          )

          const authVersion = yield* awaitReply(connection, authPacket).pipe(
            Effect.flatMap((payload) =>
              Effect.try({
                try: () => parseAuthResponse(payload),
                catch: (cause) =>
                  new PulseAudioClientError({
                    message: "failed to parse auth response",
                    cause,
                  }),
              }),
            ),
          )

          yield* parseProtocolCompatibility(authVersion).pipe(
            Effect.fromResult,
            Effect.mapError(
              (message) =>
                new PulseAudioClientError({
                  message: `incompatible PulseAudio protocol: ${message}`,
                }),
            ),
          )

          connection.protocolVersion = authVersion

          const clientName = options?.clientName ?? defaults.clientName ?? "pie"
          yield* awaitReply(connection, buildSetClientNameCommand(clientName)).pipe(
            Effect.flatMap((payload) =>
              Effect.try({
                try: () => parseSetClientNameResponse(payload),
                catch: (cause) =>
                  new PulseAudioClientError({
                    message: "failed to parse set-client-name response",
                    cause,
                  }),
              }),
            ),
            Effect.asVoid,
          )
        }).pipe(
          Effect.catchIf(
            (error): error is PulseAudioClientError => error instanceof PulseAudioClientError,
            (error) => disconnectCurrent.pipe(Effect.andThen(Effect.fail(error))),
          ),
        ),
      )

    let lastConnectOptions: ConnectOptions | undefined

    const ensureConnection = Effect.gen(function* () {
      const current = yield* Ref.get(stateRef)
      if (current === null) {
        yield* connect(lastConnectOptions)
        return yield* getConnection
      }
      return current
    })

    const getServerInfo = Effect.gen(function* () {
      yield* ensureConnection
      return yield* invoke(buildGetServerInfoCommand(), parseServerInfoResponse)
    })

    const listSources = Effect.gen(function* () {
      yield* ensureConnection
      return yield* invoke(buildGetSourceListCommand(), parseSourceListResponse)
    })

    const openRecordStream = (
      options?: Partial<RecordStreamOptions>,
    ): Effect.Effect<OpenRecordStream, PulseAudioClientError> =>
      Effect.gen(function* () {
        const connection = yield* ensureConnection
        const info = yield* invoke(
          buildCreateRecordStreamCommand(options),
          parseCreateRecordStreamResponse,
        )
        const queue = yield* Queue.unbounded<Uint8Array>()
        connection.recordQueues.set(info.streamIndex, queue)
        return { info, queue }
      })

    const closeRecordStream = (streamIndex: number): Effect.Effect<void, PulseAudioClientError> =>
      Effect.gen(function* () {
        const connection = yield* ensureConnection
        const queue = connection.recordQueues.get(streamIndex)

        const deleteEffect = invoke(
          buildDeleteRecordStreamCommand(streamIndex),
          () => undefined,
        ).pipe(
          Effect.catchIf(
            (error) => error.code === 1,
            () =>
              Effect.logWarning("Record stream already closed (PA_ERR_NOENTITY)").pipe(
                Effect.asVoid,
              ),
          ),
          Effect.asVoid,
        )

        const shutdownEffect = queue ? Queue.shutdown(queue) : Effect.void

        yield* deleteEffect.pipe(
          Effect.ensuring(
            shutdownEffect.pipe(
              Effect.andThen(
                Effect.sync(() => {
                  connection.recordQueues.delete(streamIndex)
                }),
              ),
            ),
          ),
        )
      })

    yield* Effect.addFinalizer(() => disconnectCurrent)

    return PulseAudioClient.of({
      getServerInfo,
      listSources,
      openRecordStream,
      closeRecordStream,
    })
  })
