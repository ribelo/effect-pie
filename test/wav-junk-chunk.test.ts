import { test } from "node:test"
import * as assert from "node:assert/strict"
import * as Effect from "effect/Effect"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"

import { decodePcmWavFile } from "../src/wakeword/training.ts"
import { buildPcmWavHeader } from "../src/audio/pcm.js"

const makeWavWithJunkChunk = (pcmBytes: Uint8Array): Uint8Array => {
  const header = buildPcmWavHeader(pcmBytes.length, 16_000)

  const junkDataSize = 8
  const junkChunk = new Uint8Array(8 + junkDataSize)
  const junkView = new DataView(junkChunk.buffer, junkChunk.byteOffset, junkChunk.byteLength)
  for (let i = 0; i < 4; i++) {
    junkChunk[i] = "JUNK".charCodeAt(i)
  }
  junkView.setUint32(4, junkDataSize, true)
  for (let i = 8; i < junkChunk.length; i++) {
    junkChunk[i] = 0
  }

  const out = new Uint8Array(header.length + junkChunk.length + pcmBytes.length)
  out.set(header.slice(0, 36), 0)
  out.set(junkChunk, 36)
  out.set(header.slice(36, 44), 36 + junkChunk.length)
  out.set(pcmBytes, 36 + junkChunk.length + 8)

  const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
  view.setUint32(4, out.length - 8, true)

  return out
}

test("decodePcmWavFile handles JUNK chunk between fmt and data", async () => {
  const pcm = new Uint8Array(320)
  const wav = makeWavWithJunkChunk(pcm)

  const tmpFile = path.join(os.tmpdir(), `pie-test-junk-${Date.now()}.wav`)
  fs.writeFileSync(tmpFile, wav)

  try {
    const result = await Effect.runPromise(decodePcmWavFile(tmpFile))
    assert.strictEqual(result.length, pcm.length)
    assert.deepStrictEqual(result, pcm)
  } finally {
    fs.unlinkSync(tmpFile)
  }
})
