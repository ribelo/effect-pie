import { test } from "node:test"
import * as assert from "node:assert/strict"

import { processIncomingChunk } from "../src/pulse/client.ts"
import { encodePacketHeader } from "../src/pulse/protocol.ts"
import { PA_NO_INDEX } from "../src/pulse/defs.ts"

test("processIncomingChunk throws on malformed packet header with excessive length", () => {
  const connection = {
    remainder: new Uint8Array(),
    recordQueues: new Map(),
    pending: new Map(),
  } as unknown as Parameters<typeof processIncomingChunk>[0]

  const header = encodePacketHeader({
    length: 0xffffffff,
    channel: PA_NO_INDEX,
    offsetHi: 0,
    offsetLo: 0,
    flags: 0,
  })

  const chunk = new Uint8Array(header.length + 8)
  chunk.set(header, 0)

  assert.throws(() => processIncomingChunk(connection, chunk), /exceeds max/)
})

test("processIncomingChunk rejects packet length above 256 KiB", () => {
  const connection = {
    remainder: new Uint8Array(),
    recordQueues: new Map(),
    pending: new Map(),
  } as unknown as Parameters<typeof processIncomingChunk>[0]

  const header = encodePacketHeader({
    length: 256 * 1024 + 1,
    channel: PA_NO_INDEX,
    offsetHi: 0,
    offsetLo: 0,
    flags: 0,
  })

  const chunk = new Uint8Array(header.length + 8)
  chunk.set(header, 0)

  assert.throws(() => processIncomingChunk(connection, chunk), /exceeds max/)
})
