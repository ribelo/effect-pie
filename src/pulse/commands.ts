import {
  PA_COMMAND,
  PA_NATIVE_COOKIE_LENGTH,
  PA_NATIVE_PROTOCOL_VERSION,
  PA_NATIVE_PROTOCOL_VERSION as CLIENT_PROTOCOL_VERSION,
  PA_NO_INDEX,
  defaultRecordStreamOptions,
  type RecordStreamInfo,
  type RecordStreamOptions,
  type ServerInfo,
  type SourceInfo,
} from "./defs.js";
import { TagStructReader, TagStructWriter, framePacket } from "./protocol.js";

export type CommandPacket = {
  readonly tag: number;
  readonly bytes: Uint8Array;
};

export type ParsedCommandEnvelope = {
  readonly type: number;
  readonly tag: number;
  readonly body: Uint8Array;
};

let requestTag = 0xfffffffe;

const nextRequestTag = (): number => {
  requestTag = (requestTag + 1) % 0xfffffffe;
  return requestTag;
};

const commandPacket = (
  command: PA_COMMAND,
  build?: (writer: TagStructWriter) => void,
): CommandPacket => {
  const tag = nextRequestTag();
  const writer = new TagStructWriter();
  writer.addUInt32(command);
  writer.addUInt32(tag);
  build?.(writer);

  return {
    tag,
    bytes: framePacket(writer.finalize(), PA_NO_INDEX),
  };
};

export const parseCommandEnvelope = (payload: Uint8Array): ParsedCommandEnvelope => {
  const reader = new TagStructReader(payload);
  const type = reader.getUInt32();
  const tag = reader.getUInt32();
  return {
    type,
    tag,
    body: reader.remainingBytes(),
  };
};

export const parseErrorCode = (payload: Uint8Array): number | null => {
  const reader = new TagStructReader(payload);
  if (!reader.hasRemaining()) {
    return null;
  }
  return reader.getUInt32();
};

export const buildAuthCommand = (
  cookie?: Uint8Array,
  protocolVersion = PA_NATIVE_PROTOCOL_VERSION,
): CommandPacket => {
  const authCookie = cookie ?? new Uint8Array(PA_NATIVE_COOKIE_LENGTH);
  if (authCookie.length !== PA_NATIVE_COOKIE_LENGTH) {
    throw new Error(`invalid pulse cookie length: ${authCookie.length}`);
  }

  return commandPacket(PA_COMMAND.AUTH, (writer) => {
    writer.addUInt32(protocolVersion);
    writer.addArbitrary(authCookie);
  });
};

export const parseAuthResponse = (payload: Uint8Array): number => {
  const reader = new TagStructReader(payload);
  return reader.getUInt32() & 0xffff;
};

export const buildSetClientNameCommand = (
  clientNameOrProps: string | Readonly<Record<string, string>> = "effect-pi",
): CommandPacket => {
  const props =
    typeof clientNameOrProps === "string"
      ? { "application.name": clientNameOrProps }
      : clientNameOrProps;

  return commandPacket(PA_COMMAND.SET_CLIENT_NAME, (writer) => {
    writer.addProps(props);
  });
};

export const parseSetClientNameResponse = (payload: Uint8Array): number => {
  const reader = new TagStructReader(payload);
  return reader.getUInt32();
};

export const buildGetServerInfoCommand = (): CommandPacket =>
  commandPacket(PA_COMMAND.GET_SERVER_INFO);

export const parseServerInfoResponse = (payload: Uint8Array): ServerInfo => {
  const reader = new TagStructReader(payload);
  return {
    name: reader.getString() ?? "",
    version: reader.getString() ?? "",
    username: reader.getString() ?? "",
    hostname: reader.getString() ?? "",
    sampleSpec: reader.getSampleSpec(),
    defaultSink: reader.getString() ?? "",
    defaultSource: reader.getString() ?? "",
    cookie: reader.getUInt32(),
    defaultChannelMap: reader.getChannelMap(),
  };
};

export const buildGetSourceListCommand = (): CommandPacket =>
  commandPacket(PA_COMMAND.GET_SOURCE_INFO_LIST);

const parseSourceInfo = (reader: TagStructReader): SourceInfo => {
  const index = reader.getUInt32();
  const name = reader.getString();
  const description = reader.getString();
  const sampleSpec = reader.getSampleSpec();
  const channelMap = reader.getChannelMap();

  reader.getUInt32();
  reader.getCvolume();
  reader.getBool();

  const monitorIndex = reader.getUInt32();
  const monitorName = reader.getString();
  const latencyUsec = reader.getUsec();
  const driver = reader.getString();
  const flags = reader.getUInt32();

  reader.getProps();
  reader.getUsec();
  reader.getVolume();
  reader.getUInt32();
  reader.getUInt32();
  reader.getUInt32();

  const ports = reader.getUInt32();
  for (let port = 0; port < ports; port += 1) {
    reader.getString();
    reader.getString();
    reader.getUInt32();
    reader.getUInt32();
  }

  reader.getString();

  const formats = reader.getUInt8();
  for (let format = 0; format < formats; format += 1) {
    reader.getFormatInfo();
  }

  return {
    index,
    name,
    description,
    sampleSpec,
    channelMap,
    monitorIndex,
    monitorName,
    latencyUsec,
    driver,
    flags,
  };
};

export const parseSourceListResponse = (payload: Uint8Array): ReadonlyArray<SourceInfo> => {
  const reader = new TagStructReader(payload);
  const sources: Array<SourceInfo> = [];

  while (reader.hasRemaining()) {
    sources.push(parseSourceInfo(reader));
  }

  return sources;
};

export const buildCreateRecordStreamCommand = (
  options?: Partial<RecordStreamOptions>,
): CommandPacket => {
  const config = defaultRecordStreamOptions(options);

  return commandPacket(PA_COMMAND.CREATE_RECORD_STREAM, (writer) => {
    writer.addSampleSpec(config.sampleSpec);
    writer.addChannelMap(config.channelMap);
    writer.addUInt32(config.sourceIndex);
    writer.addString(config.sourceName);
    writer.addUInt32(config.maximumLength);
    writer.addBool(config.corked);
    writer.addUInt32(config.fragmentSize);
    writer.addBool(config.noRemap);
    writer.addBool(config.noRemix);
    writer.addBool(config.fixFormat);
    writer.addBool(config.fixRate);
    writer.addBool(config.fixChannels);
    writer.addBool(config.noMove);
    writer.addBool(config.variableRate);
    writer.addBool(config.peakDetect);
    writer.addBool(config.adjustLatency);
    writer.addProps(config.properties);
    writer.addUInt32(config.directOnInputIndex);
    writer.addBool(config.earlyRequests);
    writer.addBool(config.dontInhibitAutoSuspend);
    writer.addBool(config.failOnSuspend);
    writer.addUInt8(0);
    writer.addCvolume(config.volume);
    writer.addBool(config.muted);
    writer.addBool(config.volumeSet);
    writer.addBool(config.mutedSet);
    writer.addBool(config.relativeVolume);
    writer.addBool(config.passthrough);
  });
};

export const parseCreateRecordStreamResponse = (payload: Uint8Array): RecordStreamInfo => {
  const reader = new TagStructReader(payload);

  const streamIndex = reader.getUInt32();
  const sourceOutputIndex = reader.getUInt32();
  const maximumLength = reader.getUInt32();
  const fragmentSize = reader.getUInt32();
  const sampleSpec = reader.getSampleSpec();
  const channelMap = reader.getChannelMap();
  const sourceIndex = reader.getUInt32();
  const sourceName = reader.getString();
  const sourceSuspended = reader.getBool();
  const configuredSourceLatencyUsec = reader.getUsec();
  reader.getFormatInfo();

  return {
    streamIndex,
    sourceOutputIndex,
    maximumLength,
    fragmentSize,
    sampleSpec,
    channelMap,
    sourceIndex,
    sourceName,
    sourceSuspended,
    configuredSourceLatencyUsec,
  };
};

export const buildDeleteRecordStreamCommand = (streamIndex: number): CommandPacket =>
  commandPacket(PA_COMMAND.DELETE_RECORD_STREAM, (writer) => {
    writer.addUInt32(streamIndex);
  });

export const parseProtocolCompatibility = (serverProtocolVersion: number): void => {
  if (serverProtocolVersion < CLIENT_PROTOCOL_VERSION) {
    throw new Error(
      `PulseAudio server protocol ${serverProtocolVersion} is older than required ${CLIENT_PROTOCOL_VERSION}`,
    );
  }
};
