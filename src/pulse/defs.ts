import { homedir } from "node:os";

export const PA_MAX_CHANNELS = 32;
export const PA_DEFAULT_SOURCE = "@DEFAULT_SOURCE@";

export const PA_NO_VALUE = 0xffffffff;
export const PA_NO_INDEX = PA_NO_VALUE;
export const PA_NO_TAG = PA_NO_VALUE;

export const PA_NATIVE_COOKIE_LENGTH = 256;
export const PA_NATIVE_PROTOCOL_VERSION = 32;

export const PA_VOLUME_NORM = 0x10000;

const uid = typeof process.getuid === "function" ? process.getuid() : 0;

export const PA_DEFAULT_SOCKET_PATH = `/run/user/${uid}/pulse/native`;
export const PA_DEFAULT_COOKIE_PATH = `${homedir()}/.config/pulse/cookie`;

export enum PA_STREAM_DESCRIPTOR {
  LENGTH = 0,
  CHANNEL = 1,
  OFFSET_HI = 2,
  OFFSET_LO = 3,
  FLAGS = 4,
  MAX = 5,
}

export const PA_STREAM_DESCRIPTOR_SIZE = PA_STREAM_DESCRIPTOR.MAX * 4;

export enum PA_TAG {
  INVALID = 0,
  STRING = 0x74,
  STRING_NULL = 0x4e,
  U32 = 0x4c,
  U8 = 0x42,
  U64 = 0x52,
  S64 = 0x72,
  SAMPLE_SPEC = 0x61,
  ARBITRARY = 0x78,
  BOOLEAN_TRUE = 0x31,
  BOOLEAN_FALSE = 0x30,
  TIMEVAL = 0x54,
  USEC = 0x55,
  CHANNEL_MAP = 0x6d,
  CVOLUME = 0x76,
  PROPLIST = 0x50,
  VOLUME = 0x56,
  FORMAT_INFO = 0x66,
}

export enum PA_COMMAND {
  ERROR = 0,
  TIMEOUT = 1,
  REPLY = 2,
  CREATE_PLAYBACK_STREAM = 3,
  DELETE_PLAYBACK_STREAM = 4,
  CREATE_RECORD_STREAM = 5,
  DELETE_RECORD_STREAM = 6,
  EXIT = 7,
  AUTH = 8,
  SET_CLIENT_NAME = 9,
  LOOKUP_SINK = 10,
  LOOKUP_SOURCE = 11,
  DRAIN_PLAYBACK_STREAM = 12,
  STAT = 13,
  GET_PLAYBACK_LATENCY = 14,
  CREATE_UPLOAD_STREAM = 15,
  DELETE_UPLOAD_STREAM = 16,
  FINISH_UPLOAD_STREAM = 17,
  PLAY_SAMPLE = 18,
  REMOVE_SAMPLE = 19,
  GET_SERVER_INFO = 20,
  GET_SINK_INFO = 21,
  GET_SINK_INFO_LIST = 22,
  GET_SOURCE_INFO = 23,
  GET_SOURCE_INFO_LIST = 24,
}

export enum PA_SAMPLE_FORMAT {
  U8 = 0,
  ALAW = 1,
  ULAW = 2,
  S16LE = 3,
  S16BE = 4,
  FLOAT32LE = 5,
  FLOAT32BE = 6,
  S32LE = 7,
  S32BE = 8,
  S24LE = 9,
  S24BE = 10,
  S24_32LE = 11,
  S24_32BE = 12,
}

export type SampleSpec = {
  readonly format: PA_SAMPLE_FORMAT;
  readonly channels: number;
  readonly rate: number;
};

export type ChannelMap = ReadonlyArray<number>;

export type SourceInfo = {
  readonly index: number;
  readonly name: string | null;
  readonly description: string | null;
  readonly sampleSpec: SampleSpec;
  readonly channelMap: ChannelMap;
  readonly monitorIndex: number;
  readonly monitorName: string | null;
  readonly latencyUsec: bigint;
  readonly driver: string | null;
  readonly flags: number;
};

export type ServerInfo = {
  readonly name: string;
  readonly version: string;
  readonly username: string;
  readonly hostname: string;
  readonly sampleSpec: SampleSpec;
  readonly defaultSink: string;
  readonly defaultSource: string;
  readonly cookie: number;
  readonly defaultChannelMap: ChannelMap;
};

export type RecordStreamOptions = {
  readonly sampleSpec: SampleSpec;
  readonly channelMap: ChannelMap;
  readonly sourceIndex: number;
  readonly sourceName: string | null;
  readonly streamName: string | null;
  readonly maximumLength: number;
  readonly fragmentSize: number;
  readonly corked: boolean;
  readonly noRemap: boolean;
  readonly noRemix: boolean;
  readonly fixFormat: boolean;
  readonly fixRate: boolean;
  readonly fixChannels: boolean;
  readonly noMove: boolean;
  readonly variableRate: boolean;
  readonly peakDetect: boolean;
  readonly adjustLatency: boolean;
  readonly directOnInputIndex: number;
  readonly earlyRequests: boolean;
  readonly dontInhibitAutoSuspend: boolean;
  readonly failOnSuspend: boolean;
  readonly volume: ReadonlyArray<number>;
  readonly muted: boolean;
  readonly volumeSet: boolean;
  readonly mutedSet: boolean;
  readonly relativeVolume: boolean;
  readonly passthrough: boolean;
  readonly properties: Readonly<Record<string, string>>;
};

export type RecordStreamInfo = {
  readonly streamIndex: number;
  readonly sourceOutputIndex: number;
  readonly maximumLength: number;
  readonly fragmentSize: number;
  readonly sampleSpec: SampleSpec;
  readonly channelMap: ChannelMap;
  readonly sourceIndex: number;
  readonly sourceName: string | null;
  readonly sourceSuspended: boolean;
  readonly configuredSourceLatencyUsec: bigint;
};

export const defaultRecordStreamOptions = (
  overrides: Partial<RecordStreamOptions> = {},
): RecordStreamOptions => {
  const sampleSpec = overrides.sampleSpec ?? {
    format: PA_SAMPLE_FORMAT.S16LE,
    channels: 1,
    rate: 16_000,
  };

  const channelMap =
    overrides.channelMap ?? Array.from({ length: sampleSpec.channels }, (_, index) => index + 1);

  return {
    sampleSpec,
    channelMap,
    sourceIndex: overrides.sourceIndex ?? PA_NO_INDEX,
    sourceName: overrides.sourceName ?? null,
    streamName: overrides.streamName ?? null,
    maximumLength: overrides.maximumLength ?? PA_NO_VALUE,
    fragmentSize: overrides.fragmentSize ?? PA_NO_VALUE,
    corked: overrides.corked ?? false,
    noRemap: overrides.noRemap ?? false,
    noRemix: overrides.noRemix ?? false,
    fixFormat: overrides.fixFormat ?? false,
    fixRate: overrides.fixRate ?? false,
    fixChannels: overrides.fixChannels ?? false,
    noMove: overrides.noMove ?? false,
    variableRate: overrides.variableRate ?? false,
    peakDetect: overrides.peakDetect ?? false,
    adjustLatency: overrides.adjustLatency ?? false,
    directOnInputIndex: overrides.directOnInputIndex ?? PA_NO_VALUE,
    earlyRequests: overrides.earlyRequests ?? false,
    dontInhibitAutoSuspend: overrides.dontInhibitAutoSuspend ?? false,
    failOnSuspend: overrides.failOnSuspend ?? false,
    volume: overrides.volume ?? Array.from({ length: sampleSpec.channels }, () => PA_VOLUME_NORM),
    muted: overrides.muted ?? false,
    volumeSet: overrides.volumeSet ?? false,
    mutedSet: overrides.mutedSet ?? false,
    relativeVolume: overrides.relativeVolume ?? false,
    passthrough: overrides.passthrough ?? false,
    properties: overrides.properties ?? {},
  };
};
