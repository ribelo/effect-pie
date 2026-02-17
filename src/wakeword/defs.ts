export const OPENWAKEWORD_SAMPLE_RATE = 16_000;
export const OPENWAKEWORD_CHANNELS = 1;
export const OPENWAKEWORD_PCM_BYTES_PER_SAMPLE = 2;
export const OPENWAKEWORD_PCM_FRAME_SAMPLES = 1_280;
export const OPENWAKEWORD_MEL_BINS = 32;
export const OPENWAKEWORD_MEL_WINDOW_FRAMES = 76;
export const OPENWAKEWORD_MEL_STEP_FRAMES = 8;
export const OPENWAKEWORD_MEL_HISTORY_FRAMES = 970;
export const OPENWAKEWORD_FEATURE_HISTORY_FRAMES = 120;
export const OPENWAKEWORD_LOOKBACK_SAMPLES = 480;

export const OPENWAKEWORD_RUNTIME_PACKAGE = "onnxruntime-web";
export const OPENWAKEWORD_RUNTIME_VERSION = "1.22.0";

export type WakewordScoreFrame = {
  readonly timestampMs: number;
  readonly sampleIndex: number;
  readonly scores: Readonly<Record<string, number>>;
};

export type WakewordTriggerEvent = {
  readonly timestampMs: number;
  readonly model: string;
  readonly score: number;
  readonly rawScore: number;
};

export type WakewordAssetManifest = {
  readonly schemaVersion: 1;
  readonly runtime: {
    readonly package: string;
    readonly version: string;
  };
  readonly models: {
    readonly melspectrogram: string;
    readonly embedding: string;
    readonly wakewords: ReadonlyArray<string>;
  };
};

export type ResolvedWakewordAssets = {
  readonly rootDir: string;
  readonly manifestPath: string;
  readonly melspectrogramModelPath: string;
  readonly embeddingModelPath: string;
  readonly wakewordModelPaths: Readonly<Record<string, string>>;
  readonly runtimePackage: string;
  readonly runtimeVersion: string;
};
