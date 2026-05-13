import { test } from "node:test"
import * as assert from "node:assert/strict"
import * as crypto from "node:crypto"
import * as net from "node:net"
import * as os from "node:os"
import * as path from "node:path"
import { Context, Effect, Layer } from "effect"
import * as fs from "node:fs/promises"
import { RecordingCoordinator } from "../src/commands/assistant/coordinator.js"
import { DaemonClient } from "../src/daemon/client.js"
import { classifyRpcClientError, SocketPreflightError } from "../src/daemon/errors.js"
import { DaemonRpcServer } from "../src/daemon/server.js"

const makeTmpSocketPath = () =>
  path.join(os.tmpdir(), `pie-daemon-test-${process.pid}-${crypto.randomUUID()}.sock`)

const makeTmpPersistPath = () =>
  path.join(os.tmpdir(), `pie-daemon-test-${process.pid}-${crypto.randomUUID()}.json`)

const sendRaw = (socketPath: string, request: unknown): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const client = net.createConnection(socketPath, () => {
      client.write(JSON.stringify(request) + "\n")
    })
    let buffer = ""
    client.on("data", (data) => {
      buffer += data.toString()
      const lines = buffer.split("\n")
      for (let i = 0; i < lines.length - 1; i++) {
        const line = lines[i]
        if (line && line.trim()) {
          try {
            resolve(JSON.parse(line))
          } catch {
            resolve(line)
          }
          client.end()
          return
        }
      }
      buffer = lines[lines.length - 1] ?? ""
    })
    client.on("error", reject)
    setTimeout(() => reject(new Error("raw socket timeout")), 3000)
  })

const withServer = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  socketPath: string,
  persistPath: string,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const serverLayer = DaemonRpcServer.layer({ socketPath }).pipe(
        Layer.provide(RecordingCoordinator.live({ persistPath })),
      )
      yield* Layer.build(serverLayer)
      yield* Effect.sleep(200)
      return yield* effect
    }),
  )

test("Status returns initial snapshot", async () => {
  const socketPath = makeTmpSocketPath()
  const persistPath = makeTmpPersistPath()

  const program = withServer(
    Effect.gen(function* () {
      const response = yield* Effect.promise(() =>
        sendRaw(socketPath, {
          _tag: "Request",
          tag: "Status",
          id: "1",
          payload: null,
          headers: [],
        }),
      )
      const exit = (response as Record<string, unknown>)["exit"] as Record<string, unknown>
      assert.strictEqual(exit["_tag"], "Success")
      const value = exit["value"] as Record<string, unknown>
      assert.strictEqual(value["enabled"], true)
      assert.strictEqual(value["mode"], "idle")
    }),
    socketPath,
    persistPath,
  )

  await Effect.runPromise(program)
})

test("Pause followed by Status returns enabled=false", async () => {
  const socketPath = makeTmpSocketPath()
  const persistPath = makeTmpPersistPath()

  const program = withServer(
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        sendRaw(socketPath, {
          _tag: "Request",
          tag: "Pause",
          id: "1",
          payload: null,
          headers: [],
        }),
      )
      const response = yield* Effect.promise(() =>
        sendRaw(socketPath, {
          _tag: "Request",
          tag: "Status",
          id: "2",
          payload: null,
          headers: [],
        }),
      )
      const exit = (response as Record<string, unknown>)["exit"] as Record<string, unknown>
      const value = exit["value"] as Record<string, unknown>
      assert.strictEqual(value["enabled"], false)
    }),
    socketPath,
    persistPath,
  )

  await Effect.runPromise(program)
})

test("Resume followed by Status returns enabled=true", async () => {
  const socketPath = makeTmpSocketPath()
  const persistPath = makeTmpPersistPath()

  const program = withServer(
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        sendRaw(socketPath, {
          _tag: "Request",
          tag: "Pause",
          id: "1",
          payload: null,
          headers: [],
        }),
      )
      yield* Effect.promise(() =>
        sendRaw(socketPath, {
          _tag: "Request",
          tag: "Resume",
          id: "2",
          payload: null,
          headers: [],
        }),
      )
      const response = yield* Effect.promise(() =>
        sendRaw(socketPath, {
          _tag: "Request",
          tag: "Status",
          id: "3",
          payload: null,
          headers: [],
        }),
      )
      const exit = (response as Record<string, unknown>)["exit"] as Record<string, unknown>
      const value = exit["value"] as Record<string, unknown>
      assert.strictEqual(value["enabled"], true)
    }),
    socketPath,
    persistPath,
  )

  await Effect.runPromise(program)
})

test("Toggle returns new boolean and matches subsequent Status", async () => {
  const socketPath = makeTmpSocketPath()
  const persistPath = makeTmpPersistPath()

  const program = withServer(
    Effect.gen(function* () {
      const toggleResp = yield* Effect.promise(() =>
        sendRaw(socketPath, {
          _tag: "Request",
          tag: "Toggle",
          id: "1",
          payload: null,
          headers: [],
        }),
      )
      const toggleExit = (toggleResp as Record<string, unknown>)["exit"] as Record<string, unknown>
      const toggled = toggleExit["value"] as boolean

      const statusResp = yield* Effect.promise(() =>
        sendRaw(socketPath, {
          _tag: "Request",
          tag: "Status",
          id: "2",
          payload: null,
          headers: [],
        }),
      )
      const statusExit = (statusResp as Record<string, unknown>)["exit"] as Record<string, unknown>
      const snapshot = statusExit["value"] as Record<string, unknown>

      assert.strictEqual(toggled, snapshot["enabled"])
      assert.strictEqual(snapshot["enabled"], false)
    }),
    socketPath,
    persistPath,
  )

  await Effect.runPromise(program)
})

test("MeetingStart on idle returns Started with meeting-transcribe", async () => {
  const socketPath = makeTmpSocketPath()
  const persistPath = makeTmpPersistPath()

  const program = withServer(
    Effect.gen(function* () {
      const response = yield* Effect.promise(() =>
        sendRaw(socketPath, {
          _tag: "Request",
          tag: "MeetingStart",
          id: "1",
          payload: null,
          headers: [],
        }),
      )
      const exit = (response as Record<string, unknown>)["exit"] as Record<string, unknown>
      const value = exit["value"] as Record<string, unknown>
      const result = value["result"] as Record<string, unknown>
      const snapshot = value["snapshot"] as Record<string, unknown>
      assert.strictEqual(result["_tag"], "Started")
      assert.strictEqual(snapshot["mode"], "meeting-transcribe")
    }),
    socketPath,
    persistPath,
  )

  await Effect.runPromise(program)
})

test("MeetingStart while active returns Busy", async () => {
  const socketPath = makeTmpSocketPath()
  const persistPath = makeTmpPersistPath()

  const program = withServer(
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        sendRaw(socketPath, {
          _tag: "Request",
          tag: "MeetingStart",
          id: "1",
          payload: null,
          headers: [],
        }),
      )
      const response = yield* Effect.promise(() =>
        sendRaw(socketPath, {
          _tag: "Request",
          tag: "MeetingStart",
          id: "2",
          payload: null,
          headers: [],
        }),
      )
      const exit = (response as Record<string, unknown>)["exit"] as Record<string, unknown>
      const value = exit["value"] as Record<string, unknown>
      const result = value["result"] as Record<string, unknown>
      assert.strictEqual(result["_tag"], "Busy")
      assert.strictEqual(result["activeMode"], "meeting-transcribe")
    }),
    socketPath,
    persistPath,
  )

  await Effect.runPromise(program)
})

test("MeetingStop when active returns idle snapshot", async () => {
  const socketPath = makeTmpSocketPath()
  const persistPath = makeTmpPersistPath()

  const program = withServer(
    Effect.gen(function* () {
      yield* Effect.promise(() =>
        sendRaw(socketPath, {
          _tag: "Request",
          tag: "MeetingStart",
          id: "1",
          payload: null,
          headers: [],
        }),
      )
      const response = yield* Effect.promise(() =>
        sendRaw(socketPath, {
          _tag: "Request",
          tag: "MeetingStop",
          id: "2",
          payload: null,
          headers: [],
        }),
      )
      const exit = (response as Record<string, unknown>)["exit"] as Record<string, unknown>
      const snapshot = exit["value"] as Record<string, unknown>
      assert.strictEqual(snapshot["mode"], "idle")
    }),
    socketPath,
    persistPath,
  )

  await Effect.runPromise(program)
})

test("MeetingToggle flips between idle and meeting-transcribe", async () => {
  const socketPath = makeTmpSocketPath()
  const persistPath = makeTmpPersistPath()

  const program = withServer(
    Effect.gen(function* () {
      const r1 = yield* Effect.promise(() =>
        sendRaw(socketPath, {
          _tag: "Request",
          tag: "MeetingToggle",
          id: "1",
          payload: null,
          headers: [],
        }),
      )
      const s1 = ((r1 as Record<string, unknown>)["exit"] as Record<string, unknown>)[
        "value"
      ] as Record<string, unknown>
      assert.strictEqual(s1["mode"], "meeting-transcribe")

      const r2 = yield* Effect.promise(() =>
        sendRaw(socketPath, {
          _tag: "Request",
          tag: "MeetingToggle",
          id: "2",
          payload: null,
          headers: [],
        }),
      )
      const s2 = ((r2 as Record<string, unknown>)["exit"] as Record<string, unknown>)[
        "value"
      ] as Record<string, unknown>
      assert.strictEqual(s2["mode"], "idle")
    }),
    socketPath,
    persistPath,
  )

  await Effect.runPromise(program)
})

test("DaemonClient against stale socket returns NotRunning without hanging", async () => {
  const socketPath = makeTmpSocketPath()

  // Create a unix socket file without a listener (stale socket)
  const server = net.createServer()
  await new Promise<void>((resolve) => {
    server.listen(socketPath, () => resolve())
  })
  server.close()
  await new Promise<void>((resolve) => {
    server.once("close", () => resolve())
  })

  const program = Effect.gen(function* () {
    const client = yield* DaemonClient
    const error = yield* Effect.flip(client.status())
    assert.strictEqual(error.kind, "NotRunning")
  }).pipe(Effect.provide(DaemonClient.layer({ socketPath })))

  await Effect.runPromise(program)

  await fs.unlink(socketPath).catch(() => {})
})

test("socket is unlinked when server scope closes", async () => {
  const socketPath = makeTmpSocketPath()
  const persistPath = makeTmpPersistPath()

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const serverLayer = DaemonRpcServer.layer({ socketPath }).pipe(
          Layer.provide(RecordingCoordinator.live({ persistPath })),
        )
        yield* Layer.build(serverLayer)
        yield* Effect.sleep(200)

        const existsBefore = yield* Effect.promise(() =>
          fs
            .access(socketPath)
            .then(() => true)
            .catch(() => false),
        )
        assert.strictEqual(existsBefore, true)
      }),
    ),
  )

  const existsAfter = await fs
    .access(socketPath)
    .then(() => true)
    .catch(() => false)
  assert.strictEqual(existsAfter, false)
})

test("DaemonClient against nonexistent socket returns NotRunning without hanging", async () => {
  const socketPath = makeTmpSocketPath()

  const program = Effect.gen(function* () {
    const client = yield* DaemonClient
    const error = yield* Effect.flip(client.status())
    assert.strictEqual(error.kind, "NotRunning")
  }).pipe(Effect.provide(DaemonClient.layer({ socketPath })))

  await Effect.runPromise(program)
})

test("socket preflight fails loudly on non-ENOENT errors", async () => {
  const filePath = path.join(os.tmpdir(), `pie-daemon-test-file-${process.pid}`)
  await fs.writeFile(filePath, "x")
  const socketPath = path.join(filePath, "test.sock")
  const persistPath = makeTmpPersistPath()

  const program = Effect.scoped(
    Effect.gen(function* () {
      const serverLayer = DaemonRpcServer.layer({ socketPath }).pipe(
        Layer.provide(RecordingCoordinator.live({ persistPath })),
      )
      yield* Layer.build(serverLayer)
    }),
  )

  try {
    await Effect.runPromise(program)
    assert.fail("expected SocketPreflightError")
  } catch (err) {
    assert.ok(err instanceof SocketPreflightError)
    assert.ok((err as SocketPreflightError).message.includes(socketPath))
  }

  await fs.unlink(filePath).catch(() => {})
})

test("classifyRpcClientError maps ENOENT to NotRunning", () => {
  const error = classifyRpcClientError({
    reason: {
      _tag: "SocketOpenError",
      kind: "Unknown",
      message: "connect ENOENT",
      cause: Object.assign(new Error("connect ENOENT"), { code: "ENOENT" }),
    },
    message: "SocketOpenError: connect ENOENT",
  } as any)
  assert.strictEqual(error.kind, "NotRunning")
})

test("classifyRpcClientError maps ECONNREFUSED to NotRunning", () => {
  const error = classifyRpcClientError({
    reason: {
      _tag: "SocketOpenError",
      kind: "Unknown",
      message: "connect ECONNREFUSED",
      cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
    },
    message: "SocketOpenError: connect ECONNREFUSED",
  } as any)
  assert.strictEqual(error.kind, "NotRunning")
})

test("classifyRpcClientError maps SocketReadError to Transport", () => {
  const error = classifyRpcClientError({
    reason: {
      _tag: "SocketReadError",
      message: "read failed",
      cause: new Error("read failed"),
    },
    message: "SocketReadError: read failed",
  } as any)
  assert.strictEqual(error.kind, "Transport")
})

test("daemon and direct coordinator share state", async () => {
  const socketPath = makeTmpSocketPath()
  const persistPath = makeTmpPersistPath()

  const coordinatorLayer = RecordingCoordinator.live({ persistPath })
  const merged = Layer.mergeAll(
    coordinatorLayer,
    DaemonRpcServer.layer({ socketPath }).pipe(Layer.provide(coordinatorLayer)),
  )

  const program = Effect.scoped(
    Effect.gen(function* () {
      const ctx = yield* Layer.build(merged)
      yield* Effect.sleep(200)

      yield* Effect.promise(() =>
        sendRaw(socketPath, {
          _tag: "Request",
          tag: "Toggle",
          id: "1",
          payload: null,
          headers: [],
        }),
      )

      const direct = Context.get(ctx, RecordingCoordinator)
      const snapshot = yield* direct.snapshot.pipe(Effect.provideContext(ctx))
      assert.strictEqual(snapshot.enabled, false)
    }),
  )

  await Effect.runPromise(program)
})

test("classifyRpcClientError maps unknown errors to Protocol", () => {
  const error = classifyRpcClientError(new Error("something weird") as any)
  assert.strictEqual(error.kind, "Protocol")
})
