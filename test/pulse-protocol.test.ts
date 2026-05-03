import { describe, test } from "node:test"
import * as assert from "node:assert/strict"

import {
  buildAuthCommand,
  buildCreateRecordStreamCommand,
  buildDeleteRecordStreamCommand,
  buildGetServerInfoCommand,
  buildGetSourceListCommand,
  buildSetClientNameCommand,
  parseCreateRecordStreamResponse,
  parseServerInfoResponse,
  parseSourceListResponse,
} from "../src/pulse/commands.ts"
import {
  PA_COMMAND,
  PA_NATIVE_COOKIE_LENGTH,
  PA_NO_INDEX,
  PA_SAMPLE_FORMAT,
  PA_VOLUME_NORM,
} from "../src/pulse/defs.ts"
import {
  TagStructReader,
  TagStructWriter,
  framePacket,
  splitFramedPacket,
} from "../src/pulse/protocol.ts"

describe("pulse protocol", () => {
  test("frames and parses packet descriptors", () => {
    const payload = new Uint8Array([1, 2, 3, 4])
    const packet = framePacket(payload, 77, 9)

    const split = splitFramedPacket(packet)

    assert.strictEqual(split.header.length, 4)
    assert.strictEqual(split.header.channel, 77)
    assert.strictEqual(split.header.flags, 9)
    assert.deepStrictEqual(Array.from(split.payload), [1, 2, 3, 4])
  })

  test("round-trips tag struct primitive and complex tags", () => {
    const writer = new TagStructWriter()

    writer.addUInt8(7)
    writer.addUInt32(42)
    writer.addUInt64(123n)
    writer.addString("hello")
    writer.addString(null)
    writer.addBool(true)
    writer.addBool(false)
    writer.addArbitrary(new Uint8Array([9, 8, 7]))
    writer.addSampleSpec({ format: PA_SAMPLE_FORMAT.S16LE, channels: 1, rate: 16_000 })
    writer.addChannelMap([1])
    writer.addProps({ "application.name": "pie", "media.role": "production" })
    writer.addCvolume([PA_VOLUME_NORM])

    const reader = new TagStructReader(writer.finalize())

    assert.strictEqual(reader.getUInt8(), 7)
    assert.strictEqual(reader.getUInt32(), 42)
    assert.strictEqual(reader.getUInt64(), 123n)
    assert.strictEqual(reader.getString(), "hello")
    assert.strictEqual(reader.getString(), null)
    assert.strictEqual(reader.getBool(), true)
    assert.strictEqual(reader.getBool(), false)
    assert.deepStrictEqual(Array.from(reader.getArbitrary()), [9, 8, 7])
    assert.deepStrictEqual(reader.getSampleSpec(), {
      format: PA_SAMPLE_FORMAT.S16LE,
      channels: 1,
      rate: 16_000,
    })
    assert.deepStrictEqual(reader.getChannelMap(), [1])
    assert.deepStrictEqual(reader.getProps(), {
      "application.name": "pie",
      "media.role": "production",
    })
    assert.deepStrictEqual(reader.getCvolume(), [PA_VOLUME_NORM])
    assert.strictEqual(reader.hasRemaining(), false)
  })

  test("builds auth command packets", () => {
    const cookie = new Uint8Array(PA_NATIVE_COOKIE_LENGTH).fill(7)
    const auth = buildAuthCommand(cookie, 32)

    const { header, payload } = splitFramedPacket(auth.bytes)
    const reader = new TagStructReader(payload)

    assert.strictEqual(header.channel, PA_NO_INDEX)
    assert.strictEqual(reader.getUInt32(), PA_COMMAND.AUTH)
    assert.strictEqual(reader.getUInt32(), auth.tag)
    assert.strictEqual(reader.getUInt32(), 32)
    assert.deepStrictEqual(reader.getArbitrary(), cookie)
    assert.strictEqual(reader.hasRemaining(), false)
  })

  test("builds set client name command with proplist", () => {
    const command = buildSetClientNameCommand("unit-test")
    const reader = new TagStructReader(splitFramedPacket(command.bytes).payload)

    assert.strictEqual(reader.getUInt32(), PA_COMMAND.SET_CLIENT_NAME)
    assert.strictEqual(reader.getUInt32(), command.tag)
    assert.deepStrictEqual(reader.getProps(), { "application.name": "unit-test" })
  })

  test("builds create and delete record stream commands", () => {
    const create = buildCreateRecordStreamCommand({
      sampleSpec: { format: PA_SAMPLE_FORMAT.S16LE, channels: 1, rate: 16_000 },
      channelMap: [1],
      fragmentSize: 1024,
    })

    const createReader = new TagStructReader(splitFramedPacket(create.bytes).payload)

    assert.strictEqual(createReader.getUInt32(), PA_COMMAND.CREATE_RECORD_STREAM)
    assert.strictEqual(createReader.getUInt32(), create.tag)
    assert.deepStrictEqual(createReader.getSampleSpec(), {
      format: PA_SAMPLE_FORMAT.S16LE,
      channels: 1,
      rate: 16_000,
    })
    assert.deepStrictEqual(createReader.getChannelMap(), [1])
    assert.strictEqual(createReader.getUInt32(), PA_NO_INDEX)
    assert.strictEqual(createReader.getString(), null)
    assert.strictEqual(createReader.getUInt32(), 0xffffffff)
    assert.strictEqual(createReader.getBool(), false)
    assert.strictEqual(createReader.getUInt32(), 1024)

    for (let index = 0; index < 9; index += 1) {
      assert.strictEqual(createReader.getBool(), false)
    }

    assert.deepStrictEqual(createReader.getProps(), {})
    assert.strictEqual(createReader.getUInt32(), 0xffffffff)
    assert.strictEqual(createReader.getBool(), false)
    assert.strictEqual(createReader.getBool(), false)
    assert.strictEqual(createReader.getBool(), false)
    assert.strictEqual(createReader.getUInt8(), 0)
    assert.deepStrictEqual(createReader.getCvolume(), [PA_VOLUME_NORM])
    assert.strictEqual(createReader.getBool(), false)
    assert.strictEqual(createReader.getBool(), false)
    assert.strictEqual(createReader.getBool(), false)
    assert.strictEqual(createReader.getBool(), false)
    assert.strictEqual(createReader.getBool(), false)
    assert.strictEqual(createReader.hasRemaining(), false)

    const remove = buildDeleteRecordStreamCommand(99)
    const removeReader = new TagStructReader(splitFramedPacket(remove.bytes).payload)
    assert.strictEqual(removeReader.getUInt32(), PA_COMMAND.DELETE_RECORD_STREAM)
    assert.strictEqual(removeReader.getUInt32(), remove.tag)
    assert.strictEqual(removeReader.getUInt32(), 99)
    assert.strictEqual(removeReader.hasRemaining(), false)
  })

  test("parses server, source list, and create-record responses", () => {
    const serverWriter = new TagStructWriter()
    serverWriter.addString("PulseAudio")
    serverWriter.addString("16.1")
    serverWriter.addString("tester")
    serverWriter.addString("localhost")
    serverWriter.addSampleSpec({ format: PA_SAMPLE_FORMAT.S16LE, channels: 2, rate: 44_100 })
    serverWriter.addString("sink0")
    serverWriter.addString("source0")
    serverWriter.addUInt32(123)
    serverWriter.addChannelMap([1, 2])

    assert.deepStrictEqual(parseServerInfoResponse(serverWriter.finalize()), {
      name: "PulseAudio",
      version: "16.1",
      username: "tester",
      hostname: "localhost",
      sampleSpec: { format: PA_SAMPLE_FORMAT.S16LE, channels: 2, rate: 44_100 },
      defaultSink: "sink0",
      defaultSource: "source0",
      cookie: 123,
      defaultChannelMap: [1, 2],
    })

    const sourceWriter = new TagStructWriter()
    sourceWriter.addUInt32(5)
    sourceWriter.addString("source0")
    sourceWriter.addString("Built-in Audio")
    sourceWriter.addSampleSpec({ format: PA_SAMPLE_FORMAT.S16LE, channels: 1, rate: 16_000 })
    sourceWriter.addChannelMap([1])
    sourceWriter.addUInt32(1)
    sourceWriter.addCvolume([PA_VOLUME_NORM])
    sourceWriter.addBool(false)
    sourceWriter.addUInt32(7)
    sourceWriter.addString("monitor0")
    sourceWriter.addUsec(1000n)
    sourceWriter.addString("module-alsa-card.c")
    sourceWriter.addUInt32(0)
    sourceWriter.addProps({ "device.class": "sound" })
    sourceWriter.addUsec(500n)
    sourceWriter.addVolume(PA_VOLUME_NORM)
    sourceWriter.addUInt32(0)
    sourceWriter.addUInt32(65536)
    sourceWriter.addUInt32(3)
    sourceWriter.addUInt32(0)
    sourceWriter.addString(null)
    sourceWriter.addUInt8(0)

    assert.deepStrictEqual(parseSourceListResponse(sourceWriter.finalize()), [
      {
        index: 5,
        name: "source0",
        description: "Built-in Audio",
        sampleSpec: { format: PA_SAMPLE_FORMAT.S16LE, channels: 1, rate: 16_000 },
        channelMap: [1],
        monitorIndex: 7,
        monitorName: "monitor0",
        latencyUsec: 1000n,
        driver: "module-alsa-card.c",
        flags: 0,
      },
    ])

    const streamWriter = new TagStructWriter()
    streamWriter.addUInt32(12)
    streamWriter.addUInt32(20)
    streamWriter.addUInt32(65_536)
    streamWriter.addUInt32(1024)
    streamWriter.addSampleSpec({ format: PA_SAMPLE_FORMAT.S16LE, channels: 1, rate: 16_000 })
    streamWriter.addChannelMap([1])
    streamWriter.addUInt32(5)
    streamWriter.addString("source0")
    streamWriter.addBool(false)
    streamWriter.addUsec(250n)
    streamWriter.addFormatInfo(1, {})

    assert.deepStrictEqual(parseCreateRecordStreamResponse(streamWriter.finalize()), {
      streamIndex: 12,
      sourceOutputIndex: 20,
      maximumLength: 65_536,
      fragmentSize: 1024,
      sampleSpec: { format: PA_SAMPLE_FORMAT.S16LE, channels: 1, rate: 16_000 },
      channelMap: [1],
      sourceIndex: 5,
      sourceName: "source0",
      sourceSuspended: false,
      configuredSourceLatencyUsec: 250n,
    })
  })

  test("builds simple query commands", () => {
    const serverInfo = buildGetServerInfoCommand()
    const sourceList = buildGetSourceListCommand()

    const serverReader = new TagStructReader(splitFramedPacket(serverInfo.bytes).payload)
    assert.strictEqual(serverReader.getUInt32(), PA_COMMAND.GET_SERVER_INFO)
    assert.strictEqual(serverReader.getUInt32(), serverInfo.tag)
    assert.strictEqual(serverReader.hasRemaining(), false)

    const sourceReader = new TagStructReader(splitFramedPacket(sourceList.bytes).payload)
    assert.strictEqual(sourceReader.getUInt32(), PA_COMMAND.GET_SOURCE_INFO_LIST)
    assert.strictEqual(sourceReader.getUInt32(), sourceList.tag)
    assert.strictEqual(sourceReader.hasRemaining(), false)
  })
})
