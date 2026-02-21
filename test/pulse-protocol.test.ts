import { describe, expect, test } from "bun:test";

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
} from "../src/pulse/commands.ts";
import {
  PA_COMMAND,
  PA_NATIVE_COOKIE_LENGTH,
  PA_NO_INDEX,
  PA_SAMPLE_FORMAT,
  PA_VOLUME_NORM,
} from "../src/pulse/defs.ts";
import {
  TagStructReader,
  TagStructWriter,
  framePacket,
  splitFramedPacket,
} from "../src/pulse/protocol.ts";

describe("pulse protocol", () => {
  test("frames and parses packet descriptors", () => {
    const payload = new Uint8Array([1, 2, 3, 4]);
    const packet = framePacket(payload, 77, 9);

    const split = splitFramedPacket(packet);

    expect(split.header.length).toBe(4);
    expect(split.header.channel).toBe(77);
    expect(split.header.flags).toBe(9);
    expect(Array.from(split.payload)).toEqual([1, 2, 3, 4]);
  });

  test("round-trips tag struct primitive and complex tags", () => {
    const writer = new TagStructWriter();

    writer.addUInt8(7);
    writer.addUInt32(42);
    writer.addUInt64(123n);
    writer.addString("hello");
    writer.addString(null);
    writer.addBool(true);
    writer.addBool(false);
    writer.addArbitrary(new Uint8Array([9, 8, 7]));
    writer.addSampleSpec({ format: PA_SAMPLE_FORMAT.S16LE, channels: 1, rate: 16_000 });
    writer.addChannelMap([1]);
    writer.addProps({ "application.name": "pie", "media.role": "production" });
    writer.addCvolume([PA_VOLUME_NORM]);

    const reader = new TagStructReader(writer.finalize());

    expect(reader.getUInt8()).toBe(7);
    expect(reader.getUInt32()).toBe(42);
    expect(reader.getUInt64()).toBe(123n);
    expect(reader.getString()).toBe("hello");
    expect(reader.getString()).toBeNull();
    expect(reader.getBool()).toBeTrue();
    expect(reader.getBool()).toBeFalse();
    expect(Array.from(reader.getArbitrary())).toEqual([9, 8, 7]);
    expect(reader.getSampleSpec()).toEqual({
      format: PA_SAMPLE_FORMAT.S16LE,
      channels: 1,
      rate: 16_000,
    });
    expect(reader.getChannelMap()).toEqual([1]);
    expect(reader.getProps()).toEqual({
      "application.name": "pie",
      "media.role": "production",
    });
    expect(reader.getCvolume()).toEqual([PA_VOLUME_NORM]);
    expect(reader.hasRemaining()).toBeFalse();
  });

  test("builds auth command packets", () => {
    const cookie = new Uint8Array(PA_NATIVE_COOKIE_LENGTH).fill(7);
    const auth = buildAuthCommand(cookie, 32);

    const { header, payload } = splitFramedPacket(auth.bytes);
    const reader = new TagStructReader(payload);

    expect(header.channel).toBe(PA_NO_INDEX);
    expect(reader.getUInt32()).toBe(PA_COMMAND.AUTH);
    expect(reader.getUInt32()).toBe(auth.tag);
    expect(reader.getUInt32()).toBe(32);
    expect(reader.getArbitrary()).toEqual(cookie);
    expect(reader.hasRemaining()).toBeFalse();
  });

  test("builds set client name command with proplist", () => {
    const command = buildSetClientNameCommand("unit-test");
    const reader = new TagStructReader(splitFramedPacket(command.bytes).payload);

    expect(reader.getUInt32()).toBe(PA_COMMAND.SET_CLIENT_NAME);
    expect(reader.getUInt32()).toBe(command.tag);
    expect(reader.getProps()).toEqual({ "application.name": "unit-test" });
  });

  test("builds create and delete record stream commands", () => {
    const create = buildCreateRecordStreamCommand({
      sampleSpec: { format: PA_SAMPLE_FORMAT.S16LE, channels: 1, rate: 16_000 },
      channelMap: [1],
      fragmentSize: 1024,
    });

    const createReader = new TagStructReader(splitFramedPacket(create.bytes).payload);

    expect(createReader.getUInt32()).toBe(PA_COMMAND.CREATE_RECORD_STREAM);
    expect(createReader.getUInt32()).toBe(create.tag);
    expect(createReader.getSampleSpec()).toEqual({
      format: PA_SAMPLE_FORMAT.S16LE,
      channels: 1,
      rate: 16_000,
    });
    expect(createReader.getChannelMap()).toEqual([1]);
    expect(createReader.getUInt32()).toBe(PA_NO_INDEX);
    expect(createReader.getString()).toBeNull();
    expect(createReader.getUInt32()).toBe(0xffffffff);
    expect(createReader.getBool()).toBeFalse();
    expect(createReader.getUInt32()).toBe(1024);

    for (let index = 0; index < 9; index += 1) {
      expect(createReader.getBool()).toBeFalse();
    }

    expect(createReader.getProps()).toEqual({});
    expect(createReader.getUInt32()).toBe(0xffffffff);
    expect(createReader.getBool()).toBeFalse();
    expect(createReader.getBool()).toBeFalse();
    expect(createReader.getBool()).toBeFalse();
    expect(createReader.getUInt8()).toBe(0);
    expect(createReader.getCvolume()).toEqual([PA_VOLUME_NORM]);
    expect(createReader.getBool()).toBeFalse();
    expect(createReader.getBool()).toBeFalse();
    expect(createReader.getBool()).toBeFalse();
    expect(createReader.getBool()).toBeFalse();
    expect(createReader.getBool()).toBeFalse();
    expect(createReader.hasRemaining()).toBeFalse();

    const remove = buildDeleteRecordStreamCommand(99);
    const removeReader = new TagStructReader(splitFramedPacket(remove.bytes).payload);
    expect(removeReader.getUInt32()).toBe(PA_COMMAND.DELETE_RECORD_STREAM);
    expect(removeReader.getUInt32()).toBe(remove.tag);
    expect(removeReader.getUInt32()).toBe(99);
    expect(removeReader.hasRemaining()).toBeFalse();
  });

  test("parses server, source list, and create-record responses", () => {
    const serverWriter = new TagStructWriter();
    serverWriter.addString("PulseAudio");
    serverWriter.addString("16.1");
    serverWriter.addString("tester");
    serverWriter.addString("localhost");
    serverWriter.addSampleSpec({ format: PA_SAMPLE_FORMAT.S16LE, channels: 2, rate: 44_100 });
    serverWriter.addString("sink0");
    serverWriter.addString("source0");
    serverWriter.addUInt32(123);
    serverWriter.addChannelMap([1, 2]);

    expect(parseServerInfoResponse(serverWriter.finalize())).toEqual({
      name: "PulseAudio",
      version: "16.1",
      username: "tester",
      hostname: "localhost",
      sampleSpec: { format: PA_SAMPLE_FORMAT.S16LE, channels: 2, rate: 44_100 },
      defaultSink: "sink0",
      defaultSource: "source0",
      cookie: 123,
      defaultChannelMap: [1, 2],
    });

    const sourceWriter = new TagStructWriter();
    sourceWriter.addUInt32(5);
    sourceWriter.addString("source0");
    sourceWriter.addString("Built-in Audio");
    sourceWriter.addSampleSpec({ format: PA_SAMPLE_FORMAT.S16LE, channels: 1, rate: 16_000 });
    sourceWriter.addChannelMap([1]);
    sourceWriter.addUInt32(1);
    sourceWriter.addCvolume([PA_VOLUME_NORM]);
    sourceWriter.addBool(false);
    sourceWriter.addUInt32(7);
    sourceWriter.addString("monitor0");
    sourceWriter.addUsec(1000n);
    sourceWriter.addString("module-alsa-card.c");
    sourceWriter.addUInt32(0);
    sourceWriter.addProps({ "device.class": "sound" });
    sourceWriter.addUsec(500n);
    sourceWriter.addVolume(PA_VOLUME_NORM);
    sourceWriter.addUInt32(0);
    sourceWriter.addUInt32(65536);
    sourceWriter.addUInt32(3);
    sourceWriter.addUInt32(0);
    sourceWriter.addString(null);
    sourceWriter.addUInt8(0);

    expect(parseSourceListResponse(sourceWriter.finalize())).toEqual([
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
    ]);

    const streamWriter = new TagStructWriter();
    streamWriter.addUInt32(12);
    streamWriter.addUInt32(20);
    streamWriter.addUInt32(65_536);
    streamWriter.addUInt32(1024);
    streamWriter.addSampleSpec({ format: PA_SAMPLE_FORMAT.S16LE, channels: 1, rate: 16_000 });
    streamWriter.addChannelMap([1]);
    streamWriter.addUInt32(5);
    streamWriter.addString("source0");
    streamWriter.addBool(false);
    streamWriter.addUsec(250n);
    streamWriter.addFormatInfo(1, {});

    expect(parseCreateRecordStreamResponse(streamWriter.finalize())).toEqual({
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
    });
  });

  test("builds simple query commands", () => {
    const serverInfo = buildGetServerInfoCommand();
    const sourceList = buildGetSourceListCommand();

    const serverReader = new TagStructReader(splitFramedPacket(serverInfo.bytes).payload);
    expect(serverReader.getUInt32()).toBe(PA_COMMAND.GET_SERVER_INFO);
    expect(serverReader.getUInt32()).toBe(serverInfo.tag);
    expect(serverReader.hasRemaining()).toBeFalse();

    const sourceReader = new TagStructReader(splitFramedPacket(sourceList.bytes).payload);
    expect(sourceReader.getUInt32()).toBe(PA_COMMAND.GET_SOURCE_INFO_LIST);
    expect(sourceReader.getUInt32()).toBe(sourceList.tag);
    expect(sourceReader.hasRemaining()).toBeFalse();
  });
});
