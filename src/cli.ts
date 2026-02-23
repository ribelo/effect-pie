import { NodeRuntime, NodeServices } from "@effect/platform-node";
import * as dbusNext from "dbus-next";
import type { Message as DbusMessage, MessageBus } from "dbus-next";
import { Console, Data, Effect, Fiber, Layer, Option, Ref, Stream } from "effect";
import * as Deferred from "effect/Deferred";
import { Command, Flag } from "effect/unstable/cli";
import { mkdir as mkdirNode, readFile, writeFile as writeNodeFile } from "node:fs/promises";
import * as path from "node:path";
import { createInterface } from "node:readline/promises";

import { validateWakewordAssets, WakewordAssetError } from "./wakeword/assets.js";
import { createWakewordTelemetryStream } from "./wakeword/live.js";
import {
  loadWakewordFeatureSessions,
  loadWakewordModelSessions,
  type WakewordModelSessions,
  WakewordRuntimeError,
} from "./wakeword/onnx.js";
import { makeWakewordPipeline, WakewordPipelineError } from "./wakeword/pipeline.js";
import { createWakewordTriggerMachine } from "./wakeword/trigger.js";
import {
  initializeWakewordTrainingWorkspace,
  makeWakewordTrainingPlan,
  registerWakewordModelInManifest,
  saveTrainedWakewordModel,
  trainLinearWakewordModel,
  WakewordTrainingError,
  writePcmWavFile,
} from "./wakeword/training.js";
import {
  EFFECT_PI_DATA_DIR,
  EFFECT_PI_RUNTIME_DIR,
  EFFECT_PI_WAKEWORD_CONFIG_DIR,
} from "./paths.js";
import { layer as pulseLayer, PulseAudioClient } from "./pulse/client.js";
import { PA_SAMPLE_FORMAT, type SourceInfo } from "./pulse/defs.js";
import { createRecordStream } from "./pulse/stream.js";
import {
  closeGlobalShortcutSession,
  monitorPortalSignals,
  setupGlobalShortcutSession,
} from "./wayland/globalShortcuts.js";
import { normalizeTextForInjection, typeTextInFocusedApp } from "./input/textInjection.js";
import { typeTextWithWtype, WtypeError } from "./wayland/wtype.js";
import {
  loadSttRuntimeConfig,
  STT_CONFIG_PATH,
  type SttRuntimeConfig,
  SttConfigError,
} from "./stt/config.js";
import {
  OpenRouterSttError,
  transcribeAndTranslatePcmWithOpenRouter,
  transcribePcmWithOpenRouter,
} from "./stt/openrouter.js";

const positiveIntegerFlag = (name: string, description: string, defaultValue: number) =>
  Flag.integer(name).pipe(
    Flag.withDescription(description),
    Flag.withDefault(defaultValue),
    Flag.filter(
      (value) => value > 0,
      () => `--${name} must be greater than 0`,
    ),
  );

const boundedFloatFlag = (
  name: string,
  description: string,
  defaultValue: number,
  min: number,
  max: number,
) =>
  Flag.float(name).pipe(
    Flag.withDescription(description),
    Flag.withDefault(defaultValue),
    Flag.filter(
      (value) => value >= min && value <= max,
      () => `--${name} must be between ${min} and ${max}`,
    ),
  );

const optionalPositiveIntegerFlag = (name: string, description: string) =>
  Flag.integer(name).pipe(
    Flag.optional,
    Flag.withDescription(description),
    Flag.filter(
      (value) => Option.isNone(value) || value.value > 0,
      () => `--${name} must be greater than 0`,
    ),
  );

const optionalBoundedFloatFlag = (name: string, description: string, min: number, max: number) =>
  Flag.float(name).pipe(
    Flag.optional,
    Flag.withDescription(description),
    Flag.filter(
      (value) => Option.isNone(value) || (value.value >= min && value.value <= max),
      () => `--${name} must be between ${min} and ${max}`,
    ),
  );

const optionalSourceFlag = Flag.string("source").pipe(
  Flag.optional,
  Flag.withDescription("PulseAudio source name (run `pie sources` to list)"),
);

const concatChunks = (chunks: ReadonlyArray<Uint8Array>): Uint8Array => {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);

  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }

  return out;
};

const { Message, MessageType, sessionBus } = dbusNext;

const A11Y_MANAGER_SERVICE = "org.freedesktop.a11y.Manager";
const A11Y_MANAGER_PATH = "/org/freedesktop/a11y/Manager";
const A11Y_KEYBOARD_INTERFACE = "org.freedesktop.a11y.KeyboardMonitor";
const A11Y_DBUS_CONNECT_TIMEOUT_MS = 5000;

type KeyboardMonitorKeyEvent = {
  readonly released: boolean;
  readonly state: number;
  readonly keysym: number;
  readonly unichar: number;
  readonly keycode: number;
};

class PttKeyboardError extends Data.TaggedError("PttKeyboardError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const connectKeyboardMonitorBus = (): Effect.Effect<MessageBus, PttKeyboardError, never> =>
  Effect.tryPromise({
    try: async () => {
      const bus = sessionBus();

      await new Promise<void>((resolve, reject) => {
        let finished = false;

        const finish = (callback: () => void): void => {
          if (finished) {
            return;
          }

          finished = true;
          bus.off("connect", onConnect);
          bus.off("error", onError);
          clearTimeout(timeout);
          callback();
        };

        const onConnect = (): void => {
          finish(resolve);
        };

        const onError = (error: unknown): void => {
          finish(() => {
            reject(error);
          });
        };

        const timeout = setTimeout(() => {
          finish(() => {
            reject(
              new PttKeyboardError({
                message: `Timed out connecting to session D-Bus after ${A11Y_DBUS_CONNECT_TIMEOUT_MS} ms`,
              }),
            );
          });
        }, A11Y_DBUS_CONNECT_TIMEOUT_MS);

        bus.on("connect", onConnect);
        bus.on("error", onError);

        const sender = (bus as MessageBus & { readonly name?: unknown }).name;
        if (typeof sender === "string" && sender.length > 0) {
          finish(resolve);
        }
      });

      return bus;
    },
    catch: (cause) =>
      cause instanceof PttKeyboardError
        ? cause
        : new PttKeyboardError({ message: "Failed to connect to session D-Bus", cause }),
  });

const callKeyboardMonitorMethod = (
  bus: MessageBus,
  member: "WatchKeyboard" | "UnwatchKeyboard",
): Effect.Effect<void, PttKeyboardError, never> =>
  Effect.tryPromise({
    try: async () => {
      const reply = await bus.call(
        new Message({
          destination: A11Y_MANAGER_SERVICE,
          path: A11Y_MANAGER_PATH,
          interface: A11Y_KEYBOARD_INTERFACE,
          member,
        }),
      );

      if (reply === null) {
        throw new PttKeyboardError({ message: `No D-Bus reply received for ${member}` });
      }

      if (reply.type === MessageType.ERROR) {
        const detail =
          reply.body.length > 0 && typeof reply.body[0] === "string"
            ? reply.body[0]
            : "Unknown D-Bus error";
        throw new PttKeyboardError({
          message: `${member} failed: ${reply.errorName ?? "<unknown>"} :: ${detail}`,
        });
      }

      if (reply.type !== MessageType.METHOD_RETURN) {
        throw new PttKeyboardError({
          message: `${member} returned unexpected D-Bus message type ${reply.type}`,
        });
      }
    },
    catch: (cause) =>
      cause instanceof PttKeyboardError
        ? cause
        : new PttKeyboardError({ message: `Failed to call ${member}`, cause }),
  });

const parseKeyboardMonitorSignal = (message: DbusMessage): KeyboardMonitorKeyEvent | undefined => {
  if (message.type !== MessageType.SIGNAL) {
    return undefined;
  }

  if (
    message.interface !== A11Y_KEYBOARD_INTERFACE ||
    message.member !== "KeyEvent" ||
    message.body.length < 5
  ) {
    return undefined;
  }

  const [released, state, keysym, unichar, keycode] = message.body;

  if (
    typeof released !== "boolean" ||
    typeof state !== "number" ||
    typeof keysym !== "number" ||
    typeof unichar !== "number" ||
    typeof keycode !== "number"
  ) {
    return undefined;
  }

  return {
    released,
    state,
    keysym,
    unichar,
    keycode,
  };
};

const makePttClipPath = (outputDir: string): string => {
  const now = new Date();
  const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
    now.getDate(),
  ).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}-${String(
    now.getMinutes(),
  ).padStart(2, "0")}-${String(now.getSeconds()).padStart(2, "0")}-${String(
    now.getMilliseconds(),
  ).padStart(3, "0")}`;

  return path.join(outputDir, `ptt-${stamp}.wav`);
};

class AsyncEventQueue<T> {
  private readonly values: Array<T> = [];
  private readonly waiters: Array<(value: T) => void> = [];

  push(value: T): void {
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter(value);
      return;
    }

    this.values.push(value);
  }

  take(): Promise<T> {
    const value = this.values.shift();
    if (value !== undefined) {
      return Promise.resolve(value);
    }

    return new Promise<T>((resolve) => {
      this.waiters.push(resolve);
    });
  }
}

class NoSpeechDetectedError extends Data.TaggedError("NoSpeechDetectedError")<{
  readonly message: string;
  readonly observedMaxRms: number;
  readonly threshold: number;
}> {}

class CliError extends Data.TaggedError("CliError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const pcmRms = (chunk: Uint8Array): number => {
  const sampleCount = Math.floor(chunk.length / 2);
  if (sampleCount <= 0) {
    return 0;
  }

  const view = new DataView(chunk.buffer, chunk.byteOffset, sampleCount * 2);
  let sumSquares = 0;

  for (let index = 0; index < sampleCount; index += 1) {
    const sample = view.getInt16(index * 2, true) / 32768;
    sumSquares += sample * sample;
  }

  return Math.sqrt(sumSquares / sampleCount);
};

const pcmPeak = (chunk: Uint8Array): number => {
  const sampleCount = Math.floor(chunk.length / 2);
  if (sampleCount <= 0) {
    return 0;
  }

  const view = new DataView(chunk.buffer, chunk.byteOffset, sampleCount * 2);
  let peak = 0;

  for (let index = 0; index < sampleCount; index += 1) {
    const normalized = Math.abs(view.getInt16(index * 2, true) / 32768);
    if (normalized > peak) {
      peak = normalized;
    }
  }

  return peak;
};

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const percentile = (values: ReadonlyArray<number>, rank: number): number => {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const normalizedRank = clamp(rank, 0, 1);
  const position = normalizedRank * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);

  if (lower === upper) {
    return sorted[lower] ?? 0;
  }

  const lowerValue = sorted[lower] ?? 0;
  const upperValue = sorted[upper] ?? 0;
  const weight = position - lower;

  return lowerValue * (1 - weight) + upperValue * weight;
};

type AudioMetrics = {
  readonly chunkCount: number;
  readonly rmsValues: ReadonlyArray<number>;
  readonly peakValues: ReadonlyArray<number>;
  readonly maxRms: number;
  readonly maxPeak: number;
  readonly rmsP50: number;
  readonly rmsP80: number;
  readonly rmsP95: number;
};

const isMonitorSource = (source: SourceInfo): boolean => {
  const name = source.name?.toLowerCase() ?? "";
  const description = source.description?.toLowerCase() ?? "";
  return name.includes(".monitor") || description.startsWith("monitor of");
};

const sourceProbeScore = (metrics: AudioMetrics): number =>
  Math.max(0, metrics.rmsP95 - metrics.rmsP50) * 4 + metrics.maxRms;

type WakewordCalibrationSnapshot = {
  readonly schemaVersion: 1;
  readonly createdAt: string;
  readonly sourceName: string;
  readonly noiseRmsP95: number;
  readonly speechRmsP50: number;
  readonly speechRmsP80: number;
  readonly resolved: {
    readonly speechRms: number;
    readonly speechChunks: number;
    readonly preRollMs: number;
    readonly maxWaitSeconds: number;
  };
};

const isWakewordCalibrationSnapshot = (value: unknown): value is WakewordCalibrationSnapshot => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const snapshot = value as Record<string, unknown>;
  const resolved = snapshot.resolved;

  if (typeof resolved !== "object" || resolved === null) {
    return false;
  }

  const resolvedRecord = resolved as Record<string, unknown>;

  return (
    snapshot.schemaVersion === 1 &&
    typeof snapshot.createdAt === "string" &&
    typeof snapshot.sourceName === "string" &&
    typeof snapshot.noiseRmsP95 === "number" &&
    typeof snapshot.speechRmsP50 === "number" &&
    typeof snapshot.speechRmsP80 === "number" &&
    typeof resolvedRecord.speechRms === "number" &&
    typeof resolvedRecord.speechChunks === "number" &&
    typeof resolvedRecord.preRollMs === "number" &&
    typeof resolvedRecord.maxWaitSeconds === "number"
  );
};

const readCalibrationSnapshot = (
  calibrationPath: string,
): Effect.Effect<WakewordCalibrationSnapshot | undefined> =>
  Effect.promise(async () => {
    try {
      const contents = await readFile(calibrationPath, "utf8");
      const parsed = JSON.parse(contents);
      return isWakewordCalibrationSnapshot(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  });

const writeCalibrationSnapshot = (
  calibrationPath: string,
  snapshot: WakewordCalibrationSnapshot,
): Effect.Effect<void, WakewordTrainingError> =>
  Effect.tryPromise({
    try: async () => {
      await mkdirNode(path.dirname(calibrationPath), { recursive: true });
      await writeNodeFile(calibrationPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    },
    catch: (cause) =>
      new WakewordTrainingError({
        message: `Failed to write calibration snapshot at ${calibrationPath}`,
        cause,
      }),
  });

type WakewordDetectionTuningSnapshot = {
  readonly schemaVersion: 1;
  readonly createdAt: string;
  readonly sourceName: string;
  readonly modelName: string;
  readonly modelFile: string;
  readonly trigger: {
    readonly threshold: number;
    readonly smoothingWindow: number;
    readonly consecutiveFrames: number;
    readonly cooldownMs: number;
  };
  readonly metrics: {
    readonly silenceP99: number;
    readonly negativeP99: number;
    readonly positiveP90: number;
    readonly positiveEstimatedPhrases: number;
    readonly positiveTriggers: number;
    readonly negativeTriggers: number;
    readonly silenceTriggers: number;
  };
};

type CapturedScoreFrame = {
  readonly timestampMs: number;
  readonly score: number;
};

type TriggerTuningConfig = {
  readonly threshold: number;
  readonly smoothingWindow: number;
  readonly consecutiveFrames: number;
  readonly cooldownMs: number;
};

type TriggerTuningEvaluation = {
  readonly config: TriggerTuningConfig;
  readonly silenceTriggers: number;
  readonly negativeTriggers: number;
  readonly positiveTriggers: number;
  readonly targetPositiveTriggers: number;
  readonly objective: number;
};

const isWakewordDetectionTuningSnapshot = (
  value: unknown,
): value is WakewordDetectionTuningSnapshot => {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const snapshot = value as Record<string, unknown>;
  const trigger = snapshot.trigger;
  const metrics = snapshot.metrics;

  if (typeof trigger !== "object" || trigger === null) {
    return false;
  }

  if (typeof metrics !== "object" || metrics === null) {
    return false;
  }

  const triggerRecord = trigger as Record<string, unknown>;
  const metricsRecord = metrics as Record<string, unknown>;

  return (
    snapshot.schemaVersion === 1 &&
    typeof snapshot.createdAt === "string" &&
    typeof snapshot.sourceName === "string" &&
    typeof snapshot.modelName === "string" &&
    typeof snapshot.modelFile === "string" &&
    typeof triggerRecord.threshold === "number" &&
    typeof triggerRecord.smoothingWindow === "number" &&
    typeof triggerRecord.consecutiveFrames === "number" &&
    typeof triggerRecord.cooldownMs === "number" &&
    typeof metricsRecord.silenceP99 === "number" &&
    typeof metricsRecord.negativeP99 === "number" &&
    typeof metricsRecord.positiveP90 === "number" &&
    typeof metricsRecord.positiveEstimatedPhrases === "number" &&
    typeof metricsRecord.positiveTriggers === "number" &&
    typeof metricsRecord.negativeTriggers === "number" &&
    typeof metricsRecord.silenceTriggers === "number"
  );
};

const readDetectionTuningSnapshot = (
  tuningPath: string,
): Effect.Effect<WakewordDetectionTuningSnapshot | undefined> =>
  Effect.promise(async () => {
    try {
      const contents = await readFile(tuningPath, "utf8");
      const parsed = JSON.parse(contents);
      return isWakewordDetectionTuningSnapshot(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  });

const writeDetectionTuningSnapshot = (
  tuningPath: string,
  snapshot: WakewordDetectionTuningSnapshot,
): Effect.Effect<void, WakewordTrainingError> =>
  Effect.tryPromise({
    try: async () => {
      await mkdirNode(path.dirname(tuningPath), { recursive: true });
      await writeNodeFile(tuningPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    },
    catch: (cause) =>
      new WakewordTrainingError({
        message: `Failed to write wakeword tuning snapshot at ${tuningPath}`,
        cause,
      }),
  });

const detectionTuningPathFor = (modelName: string): string =>
  path.join(EFFECT_PI_WAKEWORD_CONFIG_DIR, modelName, "detection-tuning.json");

const calibrationPathFor = (modelName: string): string =>
  path.join(EFFECT_PI_WAKEWORD_CONFIG_DIR, modelName, "calibration.json");

const summarizeScores = (
  scores: ReadonlyArray<number>,
): {
  readonly p90: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
  readonly mean: number;
} => ({
  p90: percentile(scores, 0.9),
  p95: percentile(scores, 0.95),
  p99: percentile(scores, 0.99),
  max: scores.reduce((max, value) => (value > max ? value : max), 0),
  mean: scores.length === 0 ? 0 : scores.reduce((sum, value) => sum + value, 0) / scores.length,
});

const countTriggersForFrames = (
  frames: ReadonlyArray<CapturedScoreFrame>,
  modelName: string,
  config: TriggerTuningConfig,
): number => {
  const machine = createWakewordTriggerMachine(config);
  let triggerCount = 0;

  for (const frame of frames) {
    const events = machine.processFrame({
      timestampMs: frame.timestampMs,
      sampleIndex: Math.round((frame.timestampMs / 1000) * 16_000),
      scores: {
        [modelName]: frame.score,
      },
    });

    for (const event of events) {
      if (event.model === modelName) {
        triggerCount += 1;
      }
    }
  }

  return triggerCount;
};

const estimateWakePhraseCount = (
  frames: ReadonlyArray<CapturedScoreFrame>,
  minGapMs = 700,
): number => {
  if (frames.length === 0) {
    return 0;
  }

  const scores = frames.map((frame) => frame.score);
  const gate = clamp(Math.max(percentile(scores, 0.9) * 0.6, 0.12), 0.12, 0.8);

  let inRegion = false;
  let peakScore = 0;
  let peakTime = 0;
  let lastAcceptedPeak = Number.NEGATIVE_INFINITY;
  let peaks = 0;

  for (const frame of frames) {
    if (frame.score >= gate) {
      inRegion = true;
      if (frame.score >= peakScore) {
        peakScore = frame.score;
        peakTime = frame.timestampMs;
      }
      continue;
    }

    if (inRegion && frame.score < gate * 0.6) {
      if (peakTime - lastAcceptedPeak >= minGapMs) {
        peaks += 1;
        lastAcceptedPeak = peakTime;
      }
      inRegion = false;
      peakScore = 0;
      peakTime = 0;
    }
  }

  if (inRegion && peakTime - lastAcceptedPeak >= minGapMs) {
    peaks += 1;
  }

  return peaks;
};

const candidateThresholds = (
  silenceScores: ReadonlyArray<number>,
  negativeScores: ReadonlyArray<number>,
  positiveScores: ReadonlyArray<number>,
): ReadonlyArray<number> => {
  const floor = clamp(
    Math.max(percentile(silenceScores, 0.995), percentile(negativeScores, 0.995)) + 0.02,
    0.08,
    0.85,
  );
  const ceiling = clamp(Math.max(floor + 0.12, percentile(positiveScores, 0.95)), 0.2, 0.98);

  const values = new Set<number>();

  for (let threshold = floor; threshold <= ceiling + 0.0001; threshold += 0.02) {
    values.add(Number(threshold.toFixed(3)));
  }

  for (const threshold of [0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.7]) {
    if (threshold >= floor - 0.02 && threshold <= ceiling + 0.02) {
      values.add(threshold);
    }
  }

  return [...values].sort((left, right) => left - right);
};

const evaluateTriggerTuning = (config: {
  readonly modelName: string;
  readonly silenceFrames: ReadonlyArray<CapturedScoreFrame>;
  readonly negativeFrames: ReadonlyArray<CapturedScoreFrame>;
  readonly positiveFrames: ReadonlyArray<CapturedScoreFrame>;
  readonly targetPositiveTriggers: number;
}): TriggerTuningEvaluation => {
  const silenceScores = config.silenceFrames.map((frame) => frame.score);
  const negativeScores = config.negativeFrames.map((frame) => frame.score);
  const positiveScores = config.positiveFrames.map((frame) => frame.score);

  const thresholds = candidateThresholds(silenceScores, negativeScores, positiveScores);

  let best: TriggerTuningEvaluation | undefined;

  for (const threshold of thresholds) {
    for (const smoothingWindow of [1, 2, 3, 4]) {
      for (const consecutiveFrames of [1, 2, 3]) {
        for (const cooldownMs of [900, 1200, 1500, 2000]) {
          const tuning: TriggerTuningConfig = {
            threshold,
            smoothingWindow,
            consecutiveFrames,
            cooldownMs,
          };

          const silenceTriggers = countTriggersForFrames(
            config.silenceFrames,
            config.modelName,
            tuning,
          );
          const negativeTriggers = countTriggersForFrames(
            config.negativeFrames,
            config.modelName,
            tuning,
          );
          const positiveTriggers = countTriggersForFrames(
            config.positiveFrames,
            config.modelName,
            tuning,
          );

          const target = Math.max(1, config.targetPositiveTriggers);
          const recall = Math.min(1, positiveTriggers / target);
          const underfire = Math.max(0, target - positiveTriggers);
          const overfire = Math.max(0, positiveTriggers - target);
          const backgroundTriggers = silenceTriggers + negativeTriggers;

          const objective =
            recall * 100 -
            backgroundTriggers * 80 -
            underfire * 16 -
            overfire * 8 -
            threshold * 2 -
            (smoothingWindow - 1) * 0.6 -
            (consecutiveFrames - 1) * 0.8;

          const evaluation: TriggerTuningEvaluation = {
            config: tuning,
            silenceTriggers,
            negativeTriggers,
            positiveTriggers,
            targetPositiveTriggers: target,
            objective,
          };

          if (
            best === undefined ||
            evaluation.objective > best.objective ||
            (evaluation.objective === best.objective &&
              evaluation.negativeTriggers + evaluation.silenceTriggers <
                best.negativeTriggers + best.silenceTriggers)
          ) {
            best = evaluation;
          }
        }
      }
    }
  }

  return (
    best ?? {
      config: {
        threshold: 0.5,
        smoothingWindow: 2,
        consecutiveFrames: 2,
        cooldownMs: 1500,
      },
      silenceTriggers: 0,
      negativeTriggers: 0,
      positiveTriggers: 0,
      targetPositiveTriggers: Math.max(1, config.targetPositiveTriggers),
      objective: Number.NEGATIVE_INFINITY,
    }
  );
};

const drainPendingStdin = Effect.sync(() => {
  if (!process.stdin.readable) {
    return;
  }

  try {
    let chunk = process.stdin.read();
    while (chunk !== null) {
      chunk = process.stdin.read();
    }
  } catch {
    // best-effort stdin drain to avoid replaying injected text into readline prompts
  }
});

const waitForEnter = (message: string): Effect.Effect<void, WakewordTrainingError> =>
  Effect.tryPromise({
    try: async () => {
      const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      try {
        await rl.question(`${message}\n`);
      } finally {
        rl.close();
      }
    },
    catch: (cause) =>
      new WakewordTrainingError({
        message: `Failed to read terminal input for prompt: ${message}`,
        cause,
      }),
  });

const collectAudioMetricsInteractive = (config: {
  readonly fragmentSize: number;
  readonly sampleRate: number;
  readonly channels: number;
  readonly sourceName: string;
  readonly startPrompt: string;
  readonly stopPrompt: string;
}): Effect.Effect<AudioMetrics, Error | WakewordTrainingError, PulseAudioClient> =>
  Effect.gen(function* () {
    yield* waitForEnter(config.startPrompt);

    const rmsValues: Array<number> = [];
    const peakValues: Array<number> = [];

    const recordOptions: {
      sampleSpec: {
        format: PA_SAMPLE_FORMAT;
        channels: number;
        rate: number;
      };
      fragmentSize: number;
      sourceName?: string;
    } = {
      sampleSpec: {
        format: PA_SAMPLE_FORMAT.S16LE,
        channels: config.channels,
        rate: config.sampleRate,
      },
      fragmentSize: config.fragmentSize,
      sourceName: config.sourceName,
    };

    const fiber = yield* createRecordStream(recordOptions).pipe(
      Stream.runForEach((chunk) =>
        Effect.sync(() => {
          rmsValues.push(pcmRms(chunk));
          peakValues.push(pcmPeak(chunk));
        }),
      ),
      Effect.forkDetach,
    );

    yield* waitForEnter(config.stopPrompt);
    yield* Fiber.interrupt(fiber);

    if (rmsValues.length === 0) {
      return yield* new CliError({
        message: "No audio captured while collecting metrics",
      });
    }

    return {
      chunkCount: rmsValues.length,
      rmsValues,
      peakValues,
      maxRms: rmsValues.reduce((max, value) => (value > max ? value : max), 0),
      maxPeak: peakValues.reduce((max, value) => (value > max ? value : max), 0),
      rmsP50: percentile(rmsValues, 0.5),
      rmsP80: percentile(rmsValues, 0.8),
      rmsP95: percentile(rmsValues, 0.95),
    };
  });

const collectWakewordScoresInteractive = (config: {
  readonly startPrompt: string;
  readonly stopPrompt: string;
  readonly sourceName: string;
  readonly fragmentSize: number;
  readonly modelName: string;
  readonly sessions: WakewordModelSessions;
}): Effect.Effect<
  ReadonlyArray<CapturedScoreFrame>,
  WakewordTrainingError | Error,
  PulseAudioClient
> =>
  Effect.gen(function* () {
    yield* waitForEnter(config.startPrompt);

    const pipeline = yield* makeWakewordPipeline(config.sessions).pipe(
      Effect.mapError(
        (cause: WakewordPipelineError) =>
          new WakewordTrainingError({
            message: `Failed to initialize wakeword pipeline for tuning: ${cause.message}`,
          }),
      ),
    );

    const frames: Array<CapturedScoreFrame> = [];
    let totalScoreFrames = 0;
    const observedModelNames = new Set<string>();

    const recordOptions = {
      sampleSpec: {
        format: PA_SAMPLE_FORMAT.S16LE,
        channels: 1,
        rate: 16_000,
      },
      fragmentSize: config.fragmentSize,
      sourceName: config.sourceName,
    };

    const fiber = yield* createRecordStream(recordOptions).pipe(
      Stream.runForEach((chunk) =>
        Effect.gen(function* () {
          const scoreFrames = yield* pipeline.feedPcmChunk(chunk).pipe(
            Effect.mapError(
              (cause: WakewordPipelineError) =>
                new WakewordTrainingError({
                  message: `Wakeword pipeline failed while collecting tuning scores: ${cause.message}`,
                }),
            ),
          );

          totalScoreFrames += scoreFrames.length;

          for (const frame of scoreFrames) {
            for (const model of Object.keys(frame.scores)) {
              observedModelNames.add(model);
            }

            const score = frame.scores[config.modelName];
            if (score !== undefined) {
              frames.push({
                timestampMs: frame.timestampMs,
                score,
              });
            }
          }
        }),
      ),
      Effect.forkDetach,
    );

    yield* waitForEnter(config.stopPrompt);
    yield* Fiber.interrupt(fiber);

    if (frames.length === 0) {
      if (totalScoreFrames === 0) {
        return yield* new CliError({
          message: "No wakeword score frames captured during tuning",
        });
      }

      const observed = [...observedModelNames].sort();
      if (observed.length > 0) {
        return yield* new CliError({
          message: `Model '${config.modelName}' produced no scores during tuning. Observed models: ${observed.join(", ")}. Use --model to tune an observed model.`,
        });
      }

      return yield* new CliError({
        message: `Model '${config.modelName}' produced no scores during tuning. This usually means the model input shape does not match current wakeword features.`,
      });
    }

    return frames;
  });

const recordVoiceActivatedClip = (config: {
  readonly clipSeconds: number;
  readonly maxWaitSeconds: number;
  readonly speechRmsThreshold: number;
  readonly minActiveChunks: number;
  readonly preRollMs: number;
  readonly fragmentSize: number;
  readonly sampleRate: number;
  readonly channels: number;
  readonly sourceName?: string;
}): Effect.Effect<Uint8Array, Error, PulseAudioClient> =>
  Effect.gen(function* () {
    const bytesPerSecond = config.sampleRate * config.channels * 2;
    const targetBytes = Math.max(1, Math.round(bytesPerSecond * config.clipSeconds));
    const preRollBytes = Math.round((bytesPerSecond * config.preRollMs) / 1000);
    const preRollChunks = Math.max(1, Math.ceil(preRollBytes / config.fragmentSize));

    const completion = yield* Deferred.make<Uint8Array, Error>();
    const preRollRef = yield* Ref.make<ReadonlyArray<Uint8Array>>([]);
    const collectedRef = yield* Ref.make<ReadonlyArray<Uint8Array>>([]);
    const collectedBytesRef = yield* Ref.make(0);
    const activeChunksRef = yield* Ref.make(0);
    const startedRef = yield* Ref.make(false);
    const maxObservedRmsRef = yield* Ref.make(0);
    const startedAt = Date.now();

    const recordOptions: {
      sampleSpec: {
        format: PA_SAMPLE_FORMAT;
        channels: number;
        rate: number;
      };
      fragmentSize: number;
      sourceName?: string;
    } = {
      sampleSpec: {
        format: PA_SAMPLE_FORMAT.S16LE,
        channels: config.channels,
        rate: config.sampleRate,
      },
      fragmentSize: config.fragmentSize,
    };

    if (config.sourceName !== undefined) {
      recordOptions.sourceName = config.sourceName;
    }

    const recorderFiber = yield* createRecordStream(recordOptions).pipe(
      Stream.runForEach((chunk) =>
        Effect.gen(function* () {
          const elapsedSeconds = (Date.now() - startedAt) / 1000;
          const started = yield* Ref.get(startedRef);
          const rms = pcmRms(chunk);
          yield* Ref.update(maxObservedRmsRef, (current) => (rms > current ? rms : current));

          if (!started && elapsedSeconds > config.maxWaitSeconds) {
            const observedMaxRms = yield* Ref.get(maxObservedRmsRef);
            yield* Deferred.complete(
              completion,
              Effect.fail(
                new NoSpeechDetectedError({
                  message: `No speech detected within ${config.maxWaitSeconds.toFixed(1)}s (max RMS ${observedMaxRms.toFixed(4)} < threshold ${config.speechRmsThreshold.toFixed(4)})`,
                  observedMaxRms,
                  threshold: config.speechRmsThreshold,
                }),
              ),
            );
            return;
          }

          if (!started) {
            const preRoll = yield* Ref.get(preRollRef);
            const updatedPreRoll = [...preRoll, chunk].slice(-preRollChunks);
            yield* Ref.set(preRollRef, updatedPreRoll);

            if (rms >= config.speechRmsThreshold) {
              const active = yield* Ref.updateAndGet(activeChunksRef, (value) => value + 1);
              if (active < config.minActiveChunks) {
                return;
              }

              yield* Ref.set(startedRef, true);
              yield* Ref.set(collectedRef, updatedPreRoll);
              yield* Ref.set(
                collectedBytesRef,
                updatedPreRoll.reduce((sum, item) => sum + item.length, 0),
              );
              return;
            }

            yield* Ref.set(activeChunksRef, 0);
            return;
          }

          const collected = yield* Ref.get(collectedRef);
          const next = [...collected, chunk];
          yield* Ref.set(collectedRef, next);

          const bytes = yield* Ref.updateAndGet(collectedBytesRef, (value) => value + chunk.length);
          if (bytes >= targetBytes) {
            yield* Deferred.complete(completion, Effect.succeed(concatChunks(next)));
          }
        }),
      ),
      Effect.forkDetach,
    );

    const result = yield* Deferred.await(completion).pipe(
      Effect.timeoutOrElse({
        duration: `${Math.ceil(config.maxWaitSeconds + config.clipSeconds + 2)} seconds`,
        onTimeout: () =>
          Ref.get(maxObservedRmsRef).pipe(
            Effect.flatMap((observedMaxRms) =>
              Effect.fail(
                new NoSpeechDetectedError({
                  message: `Recording timed out before collecting voice clip (max RMS ${observedMaxRms.toFixed(4)} < threshold ${config.speechRmsThreshold.toFixed(4)})`,
                  observedMaxRms,
                  threshold: config.speechRmsThreshold,
                }),
              ),
            ),
          ),
      }),
      Effect.ensuring(Fiber.interrupt(recorderFiber)),
    );

    return result;
  });

const recordPcmClip = (config: {
  readonly durationSeconds: number;
  readonly fragmentSize: number;
  readonly sampleRate: number;
  readonly channels: number;
  readonly sourceName?: string;
}): Effect.Effect<Uint8Array, Error, PulseAudioClient> =>
  Effect.gen(function* () {
    const chunksRef = yield* Ref.make<ReadonlyArray<Uint8Array>>([]);

    const recordOptions: {
      sampleSpec: {
        format: PA_SAMPLE_FORMAT;
        channels: number;
        rate: number;
      };
      fragmentSize: number;
      sourceName?: string;
    } = {
      sampleSpec: {
        format: PA_SAMPLE_FORMAT.S16LE,
        channels: config.channels,
        rate: config.sampleRate,
      },
      fragmentSize: config.fragmentSize,
    };

    if (config.sourceName !== undefined) {
      recordOptions.sourceName = config.sourceName;
    }

    const fiber = yield* createRecordStream(recordOptions).pipe(
      Stream.runForEach((chunk) => Ref.update(chunksRef, (chunks) => [...chunks, chunk])),
      Effect.forkDetach,
    );

    yield* Effect.sleep(`${config.durationSeconds} seconds`);
    yield* Fiber.interrupt(fiber);

    const chunks = yield* Ref.get(chunksRef);
    if (chunks.length === 0) {
      return yield* new CliError({
        message: "No audio captured for training clip",
      });
    }

    return concatChunks(chunks);
  });

const recordPcmUntilTrailingSilence = (config: {
  readonly silenceSeconds: number;
  readonly maxSeconds: number;
  readonly speechStartTimeoutSeconds?: number;
  readonly speechRmsThreshold: number;
  readonly fragmentSize: number;
  readonly sampleRate: number;
  readonly channels: number;
  readonly sourceName?: string;
}): Effect.Effect<Uint8Array, NoSpeechDetectedError | CliError, PulseAudioClient> =>
  Effect.gen(function* () {
    const bytesPerSecond = config.sampleRate * config.channels * 2;
    const chunkDurationSeconds = config.fragmentSize / bytesPerSecond;
    const silenceChunksTarget = Math.max(
      1,
      Math.ceil(config.silenceSeconds / chunkDurationSeconds),
    );
    const speechStartTimeoutSeconds = Math.min(
      config.maxSeconds,
      config.speechStartTimeoutSeconds ?? config.maxSeconds,
    );

    const completion = yield* Deferred.make<Uint8Array, NoSpeechDetectedError | CliError>();
    const chunksRef = yield* Ref.make<ReadonlyArray<Uint8Array>>([]);
    const capturedChunksRef = yield* Ref.make(0);
    const seenSpeechRef = yield* Ref.make(false);
    const silenceChunksRef = yield* Ref.make(0);
    const maxObservedRmsRef = yield* Ref.make(0);

    const recordOptions: {
      sampleSpec: {
        format: PA_SAMPLE_FORMAT;
        channels: number;
        rate: number;
      };
      fragmentSize: number;
      sourceName?: string;
    } = {
      sampleSpec: {
        format: PA_SAMPLE_FORMAT.S16LE,
        channels: config.channels,
        rate: config.sampleRate,
      },
      fragmentSize: config.fragmentSize,
    };

    if (config.sourceName !== undefined) {
      recordOptions.sourceName = config.sourceName;
    }

    const recorderFiber = yield* createRecordStream(recordOptions).pipe(
      Stream.runForEach((chunk) =>
        Effect.gen(function* () {
          const copied = chunk.slice();
          yield* Ref.update(chunksRef, (chunks) => [...chunks, copied]);

          const capturedChunks = yield* Ref.updateAndGet(capturedChunksRef, (value) => value + 1);
          const rms = pcmRms(copied);
          yield* Ref.update(maxObservedRmsRef, (current) => (rms > current ? rms : current));

          if (rms >= config.speechRmsThreshold) {
            yield* Ref.set(seenSpeechRef, true);
            yield* Ref.set(silenceChunksRef, 0);
            return;
          }

          const seenSpeech = yield* Ref.get(seenSpeechRef);
          if (!seenSpeech) {
            const elapsedSeconds = capturedChunks * chunkDurationSeconds;
            if (elapsedSeconds >= speechStartTimeoutSeconds) {
              const observed = yield* Ref.get(maxObservedRmsRef);
              yield* Deferred.complete(
                completion,
                Effect.fail(
                  new NoSpeechDetectedError({
                    message: `No speech detected within ${speechStartTimeoutSeconds.toFixed(1)}s (max RMS ${observed.toFixed(4)} < threshold ${config.speechRmsThreshold.toFixed(4)})`,
                    observedMaxRms: observed,
                    threshold: config.speechRmsThreshold,
                  }),
                ),
              );
            }
            return;
          }

          const silenceChunks = yield* Ref.updateAndGet(silenceChunksRef, (value) => value + 1);
          if (silenceChunks >= silenceChunksTarget) {
            const chunks = yield* Ref.get(chunksRef);
            yield* Deferred.complete(completion, Effect.succeed(concatChunks(chunks)));
          }
        }),
      ),
      Effect.forkDetach,
    );

    const result = yield* Deferred.await(completion).pipe(
      Effect.timeoutOrElse({
        duration: `${Math.ceil(config.maxSeconds + 2)} seconds`,
        onTimeout: () =>
          Effect.gen(function* () {
            const chunks = yield* Ref.get(chunksRef);
            const seenSpeech = yield* Ref.get(seenSpeechRef);

            if (seenSpeech && chunks.length > 0) {
              return concatChunks(chunks);
            }

            const observed = yield* Ref.get(maxObservedRmsRef);
            return yield* new NoSpeechDetectedError({
              message: `No speech detected before timeout (${config.maxSeconds.toFixed(1)}s, max RMS ${observed.toFixed(4)} < threshold ${config.speechRmsThreshold.toFixed(4)})`,
              observedMaxRms: observed,
              threshold: config.speechRmsThreshold,
            });
          }),
      }),
      Effect.ensuring(Fiber.interrupt(recorderFiber)),
    );

    if (result.length === 0) {
      return yield* new CliError({
        message: "No audio captured for wakeword dictation",
      });
    }

    return result;
  });

const recordCommand = Command.make(
  "record",
  {
    duration: positiveIntegerFlag("duration", "Recording duration in seconds", 3),
    output: Flag.string("output").pipe(
      Flag.optional,
      Flag.withDescription("Write raw PCM to this file"),
    ),
    sampleRate: positiveIntegerFlag("sample-rate", "Sample rate in Hz", 16_000),
    channels: positiveIntegerFlag("channels", "Number of channels", 1),
    fragmentSize: positiveIntegerFlag("fragment-size", "PulseAudio fragment size in bytes", 1024),
    source: optionalSourceFlag,
  },
  (config) =>
    Effect.gen(function* () {
      const client = yield* PulseAudioClient;
      yield* client.connect();

      const program = Effect.gen(function* () {
        const byteCountRef = yield* Ref.make(0);
        const chunksRef = yield* Ref.make<ReadonlyArray<Uint8Array>>([]);

        const recordOptions: {
          sampleSpec: {
            format: PA_SAMPLE_FORMAT;
            channels: number;
            rate: number;
          };
          fragmentSize: number;
          sourceName?: string;
        } = {
          sampleSpec: {
            format: PA_SAMPLE_FORMAT.S16LE,
            channels: config.channels,
            rate: config.sampleRate,
          },
          fragmentSize: config.fragmentSize,
        };

        if (Option.isSome(config.source)) {
          recordOptions.sourceName = config.source.value;
        }

        const recordFiber = yield* createRecordStream(recordOptions).pipe(
          Stream.runForEach((chunk) =>
            Effect.gen(function* () {
              yield* Ref.update(byteCountRef, (count) => count + chunk.length);
              if (Option.isSome(config.output)) {
                yield* Ref.update(chunksRef, (chunks) => [...chunks, chunk]);
              }
            }),
          ),
          Effect.forkDetach,
        );

        yield* Effect.sleep(`${config.duration} seconds`);
        yield* Fiber.interrupt(recordFiber);

        const byteCount = yield* Ref.get(byteCountRef);
        if (byteCount <= 0) {
          return yield* new CliError({
            message: "No audio data received from PulseAudio",
          });
        }

        if (Option.isSome(config.output)) {
          const outputPath = config.output.value;
          const chunks = yield* Ref.get(chunksRef);
          const data = concatChunks(chunks);
          yield* Effect.tryPromise({
            try: () => writeNodeFile(outputPath, data),
            catch: (cause) =>
              new CliError({
                message: `Failed to write output file: ${String(cause)}`,
                cause,
              }),
          });
        }

        const samplesPerChannel = Math.floor(byteCount / 2 / config.channels);
        const seconds = samplesPerChannel / config.sampleRate;

        if (Option.isSome(config.output)) {
          yield* Console.log(
            `Recorded ${byteCount} bytes (${seconds.toFixed(2)}s) to ${config.output.value}`,
          );
        } else {
          yield* Console.log(`Recorded ${byteCount} bytes (${seconds.toFixed(2)}s)`);
        }
      });

      yield* program.pipe(Effect.ensuring(client.disconnect));
    }),
).pipe(Command.withDescription("Record PCM audio from PulseAudio"));

const sourcesCommand = Command.make("sources", {}, () =>
  Effect.gen(function* () {
    const client = yield* PulseAudioClient;
    yield* client.connect();

    const program = Effect.gen(function* () {
      const serverInfo = yield* client.getServerInfo;
      const sources = yield* client.listSources;

      yield* Console.log(`Default source: ${serverInfo.defaultSource}`);
      yield* Console.log(`Available sources (${sources.length}):`);

      for (const source of sources) {
        const marker = source.name === serverInfo.defaultSource ? "*" : " ";
        const name = source.name ?? "<unnamed>";
        const description = source.description ?? "<no description>";
        yield* Console.log(
          `${marker} index=${source.index} name=${name} desc=${description} rate=${source.sampleSpec.rate} channels=${source.sampleSpec.channels}`,
        );
      }

      yield* Console.log(
        "Use --source <name> with record/wakeword/wakeword-train to pin input source",
      );
    });

    yield* program.pipe(Effect.ensuring(client.disconnect));
  }),
).pipe(Command.withDescription("List PulseAudio capture sources and default source"));

const meterCommand = Command.make(
  "meter",
  {
    duration: positiveIntegerFlag("duration", "Meter duration in seconds", 10),
    sampleRate: positiveIntegerFlag("sample-rate", "Sample rate in Hz", 16_000),
    channels: positiveIntegerFlag("channels", "Number of channels", 1),
    fragmentSize: positiveIntegerFlag("fragment-size", "PulseAudio fragment size in bytes", 1024),
    every: positiveIntegerFlag("every", "Print metrics every N chunks", 1),
    source: optionalSourceFlag,
  },
  (config) =>
    Effect.gen(function* () {
      const client = yield* PulseAudioClient;
      yield* client.connect();

      const program = Effect.gen(function* () {
        const maxRmsRef = yield* Ref.make(0);
        const maxPeakRef = yield* Ref.make(0);
        const chunkCountRef = yield* Ref.make(0);

        const recordOptions: {
          sampleSpec: {
            format: PA_SAMPLE_FORMAT;
            channels: number;
            rate: number;
          };
          fragmentSize: number;
          sourceName?: string;
        } = {
          sampleSpec: {
            format: PA_SAMPLE_FORMAT.S16LE,
            channels: config.channels,
            rate: config.sampleRate,
          },
          fragmentSize: config.fragmentSize,
        };

        if (Option.isSome(config.source)) {
          recordOptions.sourceName = config.source.value;
        }

        yield* Console.log(
          `Meter running for ${config.duration}s on source ${Option.isSome(config.source) ? config.source.value : "@DEFAULT_SOURCE@"}`,
        );

        const meterFiber = yield* createRecordStream(recordOptions).pipe(
          Stream.runForEach((chunk) =>
            Effect.gen(function* () {
              const rms = pcmRms(chunk);
              const peak = pcmPeak(chunk);

              yield* Ref.update(maxRmsRef, (value) => (rms > value ? rms : value));
              yield* Ref.update(maxPeakRef, (value) => (peak > value ? peak : value));

              const chunkIndex = yield* Ref.updateAndGet(chunkCountRef, (value) => value + 1);
              if (chunkIndex % config.every === 0) {
                yield* Console.log(
                  `[meter chunk=${chunkIndex}] rms=${rms.toFixed(4)} peak=${peak.toFixed(4)}`,
                );
              }
            }),
          ),
          Effect.forkDetach,
        );

        yield* Effect.sleep(`${config.duration} seconds`);
        yield* Fiber.interrupt(meterFiber);

        const maxRms = yield* Ref.get(maxRmsRef);
        const maxPeak = yield* Ref.get(maxPeakRef);
        const chunks = yield* Ref.get(chunkCountRef);

        yield* Console.log(
          `Meter complete. chunks=${chunks} max_rms=${maxRms.toFixed(4)} max_peak=${maxPeak.toFixed(4)}`,
        );
      });

      yield* program.pipe(Effect.ensuring(client.disconnect));
    }),
).pipe(
  Command.withDescription("Print live input RMS/peak to verify microphone level and threshold"),
);

const pttPortalCommand = Command.make(
  "ptt-portal",
  {
    shortcut: Flag.string("shortcut").pipe(
      Flag.withDescription("Shortcut accelerator in portal syntax"),
      Flag.withDefault("<Ctrl><Super>space"),
    ),
    id: Flag.string("id").pipe(
      Flag.withDescription("Portal shortcut id"),
      Flag.withDefault("push_to_talk"),
    ),
    description: Flag.string("description").pipe(
      Flag.withDescription("Shortcut description shown by desktop portal"),
      Flag.withDefault("pie push-to-talk"),
    ),
    parentWindow: Flag.string("parent-window").pipe(
      Flag.withDescription("Parent window id (leave empty for headless CLI)"),
      Flag.withDefault(""),
    ),
  },
  (config) =>
    Effect.gen(function* () {
      const session = yield* setupGlobalShortcutSession({
        parentWindow: config.parentWindow,
        shortcut: {
          id: config.id,
          description: config.description,
          preferredTrigger: config.shortcut,
        },
      });

      yield* Console.log(`PTT shortcut id: ${session.shortcut.id}`);
      yield* Console.log(`Preferred trigger: ${session.shortcut.preferredTrigger}`);
      yield* Console.log(`CreateSession request handle: ${session.createRequestHandle}`);
      yield* Console.log(`BindShortcuts request handle: ${session.bindRequestHandle}`);
      yield* Console.log(`Session handle: ${session.sessionHandle}`);
      yield* Console.log(
        'Portal monitor started. Look for Member="Activated" and Member="Deactivated". Press Ctrl+C to stop.',
      );

      return yield* monitorPortalSignals().pipe(
        Effect.ensuring(closeGlobalShortcutSession(session.sessionHandle).pipe(Effect.ignore)),
      );
    }),
).pipe(Command.withDescription("Spike command for xdg-desktop-portal GlobalShortcuts capture"));

type PttTriggerBinding = {
  readonly keycode: number;
  readonly keysym: number;
};

type PttCapturedClip = {
  readonly durationMs: number;
  readonly pcmBytes: Uint8Array;
};

type KeyboardMonitorPttConfig = {
  readonly keycode: Option.Option<number>;
  readonly keysym: Option.Option<number>;
  readonly source: Option.Option<string>;
  readonly minDurationMs: number;
  readonly sampleRate: number;
  readonly fragmentSize: number;
  readonly logPrefix: string;
  readonly armedMessage: (trigger: PttTriggerBinding) => string;
  readonly onClip: (clip: PttCapturedClip) => Effect.Effect<void, PttKeyboardError>;
};

const pttKeycodeFlag = Flag.integer("keycode").pipe(
  Flag.optional,
  Flag.withDescription("Hardware keycode to use as push-to-talk trigger (learned if omitted)"),
  Flag.filter(
    (value) => Option.isNone(value) || value.value > 0,
    () => "--keycode must be greater than 0",
  ),
);

const pttKeysymFlag = Flag.integer("keysym").pipe(
  Flag.optional,
  Flag.withDescription("XKB keysym to use as trigger (alternative to --keycode)"),
  Flag.filter(
    (value) => Option.isNone(value) || value.value > 0,
    () => "--keysym must be greater than 0",
  ),
);

const toPttKeyboardError = (message: string, cause: unknown): PttKeyboardError =>
  new PttKeyboardError({
    message,
    cause,
  });

const runKeyboardMonitorPtt = (
  config: KeyboardMonitorPttConfig,
): Effect.Effect<never, PttKeyboardError, PulseAudioClient> =>
  Effect.scoped(
    Effect.gen(function* () {
      const keyboardBus = yield* connectKeyboardMonitorBus();

      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          keyboardBus.disconnect();
        }).pipe(Effect.ignore),
      );

      yield* callKeyboardMonitorMethod(keyboardBus, "WatchKeyboard");
      yield* Effect.addFinalizer(() =>
        callKeyboardMonitorMethod(keyboardBus, "UnwatchKeyboard").pipe(Effect.ignore),
      );

      const eventQueue = new AsyncEventQueue<KeyboardMonitorKeyEvent>();

      const onMessage = (message: DbusMessage): void => {
        const event = parseKeyboardMonitorSignal(message);
        if (event !== undefined) {
          eventQueue.push(event);
        }
      };

      keyboardBus.on("message", onMessage);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          keyboardBus.off("message", onMessage);
        }).pipe(Effect.ignore),
      );

      const triggerRef = yield* Ref.make<PttTriggerBinding | undefined>(
        Option.isSome(config.keycode)
          ? {
              keycode: config.keycode.value,
              keysym: Option.isSome(config.keysym) ? config.keysym.value : 0,
            }
          : Option.isSome(config.keysym)
            ? {
                keycode: 0,
                keysym: config.keysym.value,
              }
            : undefined,
      );

      if (Option.isNone(config.keycode) && Option.isNone(config.keysym)) {
        yield* Console.log(
          "PTT key not configured. Press the key you want to use for push-to-talk to learn it now.",
        );

        while (true) {
          const event = yield* Effect.promise(() => eventQueue.take());
          if (event.released) {
            continue;
          }

          yield* Ref.set(triggerRef, {
            keycode: event.keycode,
            keysym: event.keysym,
          });

          yield* Console.log(
            `Learned trigger key: keycode=${event.keycode} keysym=${event.keysym} (use --keycode ${event.keycode} for a stable binding)`,
          );
          break;
        }
      }

      const trigger = yield* Ref.get(triggerRef);
      if (trigger === undefined) {
        return yield* new PttKeyboardError({
          message: "No push-to-talk key configured. Use --keycode/--keysym or learn one.",
        });
      }

      const captureActiveRef = yield* Ref.make(false);
      const captureChunksRef = yield* Ref.make<ReadonlyArray<Uint8Array>>([]);
      const captureStartedAtRef = yield* Ref.make<number | undefined>(undefined);

      const recordOptions: {
        sampleFormat: typeof PA_SAMPLE_FORMAT.S16LE;
        sampleRate: number;
        channels: 1;
        fragmentSize: number;
        sourceName?: string;
      } = {
        sampleFormat: PA_SAMPLE_FORMAT.S16LE,
        sampleRate: config.sampleRate,
        channels: 1,
        fragmentSize: config.fragmentSize,
      };

      if (Option.isSome(config.source)) {
        recordOptions.sourceName = config.source.value;
      }

      const recordFiber = yield* createRecordStream(recordOptions).pipe(
        Stream.runForEach((chunk) =>
          Effect.gen(function* () {
            const active = yield* Ref.get(captureActiveRef);
            if (!active) {
              return;
            }

            const copied = chunk.slice();
            yield* Ref.update(captureChunksRef, (chunks) => {
              const next = chunks.slice();
              next.push(copied);
              return next;
            });
          }),
        ),
        Effect.forkDetach,
      );

      yield* Effect.addFinalizer(() => Fiber.interrupt(recordFiber).pipe(Effect.ignore));

      yield* Console.log(config.armedMessage(trigger));

      while (true) {
        const event = yield* Effect.promise(() => eventQueue.take());

        const keycodeMatches = trigger.keycode > 0 && event.keycode === trigger.keycode;
        const keysymMatches = trigger.keysym > 0 && event.keysym === trigger.keysym;

        if (!keycodeMatches && !keysymMatches) {
          continue;
        }

        if (!event.released) {
          const alreadyActive = yield* Ref.get(captureActiveRef);
          if (alreadyActive) {
            continue;
          }

          yield* Ref.set(captureChunksRef, []);
          yield* Ref.set(captureStartedAtRef, Date.now());
          yield* Ref.set(captureActiveRef, true);
          yield* Console.log(`[${config.logPrefix}] Capturing... release key to stop`);
          continue;
        }

        const wasActive = yield* Ref.get(captureActiveRef);
        if (!wasActive) {
          continue;
        }

        yield* Ref.set(captureActiveRef, false);

        const startedAt = yield* Ref.get(captureStartedAtRef);
        yield* Ref.set(captureStartedAtRef, undefined);

        const durationMs = startedAt === undefined ? 0 : Date.now() - startedAt;
        const chunks = yield* Ref.get(captureChunksRef);
        yield* Ref.set(captureChunksRef, []);

        const capturedBytes = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
        yield* Console.log(
          `[${config.logPrefix}] Capture stopped (${durationMs}ms, ${capturedBytes} bytes)`,
        );

        if (durationMs < config.minDurationMs) {
          yield* Console.log(
            `[${config.logPrefix}] Ignored short clip (${durationMs}ms < ${config.minDurationMs}ms)`,
          );
          continue;
        }

        const pcmBytes = concatChunks(chunks);
        if (pcmBytes.length === 0) {
          yield* Console.log(`[${config.logPrefix}] Ignored empty clip`);
          continue;
        }

        yield* config.onClip({
          durationMs,
          pcmBytes,
        });
      }
    }),
  );

const pttCommand = Command.make(
  "ptt",
  {
    keycode: pttKeycodeFlag,
    keysym: pttKeysymFlag,
    source: optionalSourceFlag,
    outputDir: Flag.string("output-dir").pipe(
      Flag.withDescription("Directory where captured PTT WAV clips will be saved"),
      Flag.withDefault(path.join(EFFECT_PI_DATA_DIR, "ptt-clips")),
    ),
    minDurationMs: positiveIntegerFlag(
      "min-duration-ms",
      "Ignore clips shorter than this many milliseconds",
      120,
    ),
    sampleRate: positiveIntegerFlag("sample-rate", "PCM sample rate for capture", 16_000),
    fragmentSize: positiveIntegerFlag(
      "fragment-size",
      "PulseAudio record fragment size in bytes",
      4096,
    ),
  },
  (config) =>
    runKeyboardMonitorPtt({
      keycode: config.keycode,
      keysym: config.keysym,
      source: config.source,
      minDurationMs: config.minDurationMs,
      sampleRate: config.sampleRate,
      fragmentSize: config.fragmentSize,
      logPrefix: "ptt",
      armedMessage: (trigger) =>
        `PTT armed. Hold keycode=${trigger.keycode} keysym=${trigger.keysym} to record. Clips -> ${config.outputDir}. Press Ctrl+C to stop.`,
      onClip: (clip) =>
        Effect.gen(function* () {
          const outputPath = makePttClipPath(config.outputDir);
          yield* writePcmWavFile(outputPath, clip.pcmBytes, config.sampleRate).pipe(
            Effect.mapError((cause: WakewordTrainingError) =>
              toPttKeyboardError(
                `Failed to write PTT clip at ${outputPath}: ${cause.message}`,
                cause,
              ),
            ),
          );

          const seconds = (clip.durationMs / 1000).toFixed(2);
          yield* Console.log(`[ptt] Saved ${outputPath} (${seconds}s)`);
        }),
    }),
).pipe(
  Command.withDescription(
    "Experimental keyboard-monitor push-to-talk: hold key to capture audio and save clips as WAV",
  ),
);

const pttTranscribeCommand = Command.make(
  "ptt-transcribe",
  {
    keycode: pttKeycodeFlag,
    keysym: pttKeysymFlag,
    source: optionalSourceFlag,
    minDurationMs: positiveIntegerFlag(
      "min-duration-ms",
      "Ignore clips shorter than this many milliseconds",
      120,
    ),
    sampleRate: positiveIntegerFlag("sample-rate", "PCM sample rate for capture", 16_000),
    fragmentSize: positiveIntegerFlag(
      "fragment-size",
      "PulseAudio record fragment size in bytes",
      4096,
    ),
    inject: Flag.boolean("inject").pipe(
      Flag.withDescription("Type transcript into focused app using wtype/xdotool"),
    ),
  },
  (config) =>
    Effect.gen(function* () {
      const sttConfig = yield* loadSttRuntimeConfig().pipe(
        Effect.mapError((cause: SttConfigError) =>
          toPttKeyboardError(`Failed to load STT config: ${cause.message}`, cause),
        ),
      );

      const transcriptionModel = sttConfig.openrouter.transcriptionModel;
      const transcriptionLanguage = sttConfig.openrouter.transcriptionLanguage;

      yield* Console.log(
        `[ptt-transcribe] Model: ${transcriptionModel} (config: ${STT_CONFIG_PATH})`,
      );
      yield* Console.log(`[ptt-transcribe] Language: ${transcriptionLanguage}`);

      return yield* runKeyboardMonitorPtt({
        keycode: config.keycode,
        keysym: config.keysym,
        source: config.source,
        minDurationMs: config.minDurationMs,
        sampleRate: config.sampleRate,
        fragmentSize: config.fragmentSize,
        logPrefix: "ptt-transcribe",
        armedMessage: (trigger) =>
          `PTT transcribe armed. Hold keycode=${trigger.keycode} keysym=${trigger.keysym} to dictate. Press Ctrl+C to stop.`,
        onClip: (clip) =>
          Effect.gen(function* () {
            const transcript = yield* transcribePcmWithOpenRouter({
              model: transcriptionModel,
              pcmBytes: clip.pcmBytes,
              sampleRate: config.sampleRate,
              language: transcriptionLanguage,
            }).pipe(
              Effect.mapError((cause: OpenRouterSttError) =>
                toPttKeyboardError(`STT request failed: ${cause.message}`, cause),
              ),
            );

            const text = transcript.trim();
            if (text.length === 0) {
              yield* Console.log("[ptt-transcribe] Ignored empty transcript");
              return;
            }

            yield* Console.log(`[ptt-transcribe] ${text}`);

            if (!config.inject) {
              return;
            }

            const result = yield* typeTextInFocusedApp(text).pipe(
              Effect.mapError((cause) =>
                toPttKeyboardError(
                  cause instanceof Error
                    ? `Failed to inject transcript text: ${cause.message}`
                    : "Failed to inject transcript text",
                  cause,
                ),
              ),
            );

            yield* Console.log(
              `[ptt-transcribe] Typed ${result.text.length} chars with ${result.backend} (${result.sessionType})`,
            );
          }),
      });
    }),
).pipe(
  Command.withDescription(
    "Push-to-talk transcription via OpenRouter (model configured in $XDG_CONFIG_HOME/pie/stt.json; legacy effect-pi dir preferred when present)",
  ),
);

const pttTranslateCommand = Command.make(
  "ptt-translate",
  {
    keycode: pttKeycodeFlag,
    keysym: pttKeysymFlag,
    source: optionalSourceFlag,
    minDurationMs: positiveIntegerFlag(
      "min-duration-ms",
      "Ignore clips shorter than this many milliseconds",
      120,
    ),
    sampleRate: positiveIntegerFlag("sample-rate", "PCM sample rate for capture", 16_000),
    fragmentSize: positiveIntegerFlag(
      "fragment-size",
      "PulseAudio record fragment size in bytes",
      4096,
    ),
    targetLanguage: Flag.string("target-language").pipe(
      Flag.optional,
      Flag.withDescription("Target language for translated output (defaults from STT config)"),
    ),
    inject: Flag.boolean("inject").pipe(
      Flag.withDescription("Type translated text into focused app using wtype/xdotool"),
    ),
  },
  (config) =>
    Effect.gen(function* () {
      const sttConfig = yield* loadSttRuntimeConfig().pipe(
        Effect.mapError((cause: SttConfigError) =>
          toPttKeyboardError(`Failed to load STT config: ${cause.message}`, cause),
        ),
      );

      const translationModel = sttConfig.openrouter.translationModel;
      const sourceLanguage = sttConfig.openrouter.translationSourceLanguage;
      const targetLanguage = Option.isSome(config.targetLanguage)
        ? config.targetLanguage.value
        : sttConfig.openrouter.translationTargetLanguage;

      yield* Console.log(`[ptt-translate] Model: ${translationModel} (config: ${STT_CONFIG_PATH})`);
      yield* Console.log(`[ptt-translate] Source language: ${sourceLanguage}`);
      yield* Console.log(`[ptt-translate] Target language: ${targetLanguage}`);

      return yield* runKeyboardMonitorPtt({
        keycode: config.keycode,
        keysym: config.keysym,
        source: config.source,
        minDurationMs: config.minDurationMs,
        sampleRate: config.sampleRate,
        fragmentSize: config.fragmentSize,
        logPrefix: "ptt-translate",
        armedMessage: (trigger) =>
          `PTT translate armed. Hold keycode=${trigger.keycode} keysym=${trigger.keysym} to dictate. ${sourceLanguage} -> ${targetLanguage}. Press Ctrl+C to stop.`,
        onClip: (clip) =>
          Effect.gen(function* () {
            const translated = yield* transcribeAndTranslatePcmWithOpenRouter({
              model: translationModel,
              pcmBytes: clip.pcmBytes,
              sampleRate: config.sampleRate,
              sourceLanguage,
              targetLanguage,
            }).pipe(
              Effect.mapError((cause: OpenRouterSttError) =>
                toPttKeyboardError(`STT+translation request failed: ${cause.message}`, cause),
              ),
            );

            const text = translated.trim();
            if (text.length === 0) {
              yield* Console.log("[ptt-translate] Ignored empty translation");
              return;
            }

            yield* Console.log(`[ptt-translate] ${text}`);

            if (!config.inject) {
              return;
            }

            const result = yield* typeTextInFocusedApp(text).pipe(
              Effect.mapError((cause) =>
                toPttKeyboardError(
                  cause instanceof Error
                    ? `Failed to inject translated text: ${cause.message}`
                    : "Failed to inject translated text",
                  cause,
                ),
              ),
            );

            yield* Console.log(
              `[ptt-translate] Typed ${result.text.length} chars with ${result.backend} (${result.sessionType})`,
            );
          }),
      });
    }),
).pipe(
  Command.withDescription(
    "Push-to-talk transcription + translation via OpenRouter (model configured in $XDG_CONFIG_HOME/pie/stt.json; legacy effect-pi dir preferred when present)",
  ),
);

const sttInteractiveCommand = Command.make(
  "stt-interactive",
  {
    source: optionalSourceFlag,
    minDurationMs: positiveIntegerFlag(
      "min-duration-ms",
      "Ignore clips shorter than this many milliseconds",
      120,
    ),
    sampleRate: positiveIntegerFlag("sample-rate", "PCM sample rate for capture", 16_000),
    fragmentSize: positiveIntegerFlag(
      "fragment-size",
      "PulseAudio record fragment size in bytes",
      4096,
    ),
    noType: Flag.boolean("no-type").pipe(
      Flag.withDescription("Disable typing streamed deltas via wtype"),
    ),
  },
  (config) =>
    Effect.gen(function* () {
      const sttConfig = yield* loadSttRuntimeConfig().pipe(
        Effect.mapError(
          (cause: SttConfigError) =>
            new CliError({
              message: `Failed to load STT config: ${cause.message}`,
              cause,
            }),
        ),
      );

      const transcriptionModel = sttConfig.openrouter.transcriptionModel;
      const transcriptionLanguage = sttConfig.openrouter.transcriptionLanguage;

      yield* Console.log(
        `[stt-interactive] Ready. Model=${transcriptionModel}, language=${transcriptionLanguage}. Press Enter to start, Enter to stop, Ctrl+C to exit.`,
      );

      if (!config.noType) {
        yield* Console.log(
          "[stt-interactive] Streaming deltas will be typed with wtype into the currently focused Wayland window.",
        );
      }

      while (true) {
        yield* drainPendingStdin;

        yield* waitForEnter("[stt-interactive] Press Enter to start listening").pipe(
          Effect.mapError(
            (cause: WakewordTrainingError) =>
              new CliError({
                message: cause.message,
                cause,
              }),
          ),
        );

        const chunksRef = yield* Ref.make<ReadonlyArray<Uint8Array>>([]);

        const recordOptions: {
          sampleFormat: typeof PA_SAMPLE_FORMAT.S16LE;
          sampleRate: number;
          channels: 1;
          fragmentSize: number;
          sourceName?: string;
        } = {
          sampleFormat: PA_SAMPLE_FORMAT.S16LE,
          sampleRate: config.sampleRate,
          channels: 1,
          fragmentSize: config.fragmentSize,
        };

        if (Option.isSome(config.source)) {
          recordOptions.sourceName = config.source.value;
        }

        const recordFiber = yield* createRecordStream(recordOptions).pipe(
          Stream.runForEach((chunk) => Ref.update(chunksRef, (chunks) => [...chunks, chunk])),
          Effect.forkDetach,
        );

        yield* waitForEnter("[stt-interactive] Listening... Press Enter to stop").pipe(
          Effect.mapError(
            (cause: WakewordTrainingError) =>
              new CliError({
                message: cause.message,
                cause,
              }),
          ),
        );

        yield* Fiber.interrupt(recordFiber);

        const chunks = yield* Ref.get(chunksRef);
        const pcmBytes = concatChunks(chunks);

        if (pcmBytes.length === 0) {
          yield* Console.log("[stt-interactive] Ignored empty capture");
          continue;
        }

        const durationMs = Math.round((pcmBytes.length / 2 / config.sampleRate) * 1000);
        if (durationMs < config.minDurationMs) {
          yield* Console.log(
            `[stt-interactive] Ignored short capture (${durationMs}ms < ${config.minDurationMs}ms)`,
          );
          continue;
        }

        const transcript = yield* transcribePcmWithOpenRouter({
          model: transcriptionModel,
          pcmBytes,
          sampleRate: config.sampleRate,
          language: transcriptionLanguage,
          ...(config.noType
            ? {}
            : {
                onDelta: (delta: string) =>
                  typeTextWithWtype(delta).pipe(
                    Effect.mapError(
                      (cause: WtypeError) =>
                        new OpenRouterSttError({
                          message: `Failed typing streamed delta with wtype: ${cause.message}`,
                          cause,
                        }),
                    ),
                  ),
              }),
        }).pipe(
          Effect.mapError(
            (cause: OpenRouterSttError) =>
              new CliError({
                message: `Streaming STT failed: ${cause.message}`,
                cause,
              }),
          ),
        );

        yield* Console.log("");
        yield* Console.log(`[stt-interactive] Transcript: ${transcript}`);
      }
    }),
).pipe(
  Command.withDescription(
    "Interactive STT test loop (Enter start/stop, OpenRouter streaming, optional wtype delta typing)",
  ),
);

const DEFAULT_ASSISTANT_WAKEWORD_MODEL_FILE = "ok_pie.json";
const DEFAULT_ASSISTANT_PTT_TRANSCRIBE_KEYSYM = 65478;
const DEFAULT_ASSISTANT_PTT_TRANSLATE_KEYSYM = 65479;
const DEFAULT_ASSISTANT_SAMPLE_RATE = 16_000;
const DEFAULT_ASSISTANT_WAKEWORD_FRAGMENT_SIZE = 1024;
const DEFAULT_ASSISTANT_PTT_FRAGMENT_SIZE = 4096;
const DEFAULT_ASSISTANT_MIN_DURATION_MS = 120;
const DEFAULT_ASSISTANT_WAKEWORD_SPEECH_START_TIMEOUT_SECONDS = 8;
const ASSISTANT_RECORDING_STATE_PATH = path.join(EFFECT_PI_RUNTIME_DIR, "recording.json");

const resolveWakewordSpeechStartTimeoutSeconds = (config: {
  readonly silenceSeconds: number;
  readonly maxSeconds: number;
}): number =>
  Math.min(
    config.maxSeconds,
    Math.max(DEFAULT_ASSISTANT_WAKEWORD_SPEECH_START_TIMEOUT_SECONDS, config.silenceSeconds + 2),
  );

type AssistantRecordingMode = "ptt-transcribe" | "ptt-translate" | "wakeword";

type AssistantRecordingState = {
  readonly active: boolean;
  readonly mode: AssistantRecordingMode | "idle";
  readonly startedAt: string | null;
  readonly updatedAt: string;
};

type AssistantRecordingRuntimeState = {
  readonly mode: AssistantRecordingMode | undefined;
  readonly startedAtMs: number | undefined;
};

const persistAssistantRecordingState = (
  state: AssistantRecordingState,
): Effect.Effect<void, CliError> =>
  Effect.tryPromise({
    try: async () => {
      await mkdirNode(path.dirname(ASSISTANT_RECORDING_STATE_PATH), { recursive: true });
      await writeNodeFile(
        ASSISTANT_RECORDING_STATE_PATH,
        `${JSON.stringify(state, null, 2)}\n`,
        "utf8",
      );
    },
    catch: (cause) =>
      new CliError({
        message: `Failed to write assistant recording state at ${ASSISTANT_RECORDING_STATE_PATH}`,
        cause,
      }),
  });

const setAssistantRecordingMode = (config: {
  readonly ref: Ref.Ref<AssistantRecordingRuntimeState>;
  readonly mode: AssistantRecordingMode | undefined;
}): Effect.Effect<void, never> =>
  Effect.gen(function* () {
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();

    const state = yield* Ref.modify(config.ref, (current) => {
      if (config.mode === undefined) {
        const nextState: AssistantRecordingState = {
          active: false,
          mode: "idle",
          startedAt: null,
          updatedAt: nowIso,
        };

        const nextRuntime: AssistantRecordingRuntimeState = {
          mode: undefined,
          startedAtMs: undefined,
        };

        return [nextState, nextRuntime] as const;
      }

      const startedAtMs =
        current.mode === config.mode && current.startedAtMs !== undefined
          ? current.startedAtMs
          : nowMs;

      const nextState: AssistantRecordingState = {
        active: true,
        mode: config.mode,
        startedAt: new Date(startedAtMs).toISOString(),
        updatedAt: nowIso,
      };

      const nextRuntime: AssistantRecordingRuntimeState = {
        mode: config.mode,
        startedAtMs,
      };

      return [nextState, nextRuntime] as const;
    });

    yield* persistAssistantRecordingState(state).pipe(
      Effect.catch((cause: CliError) => Console.log(`[assistant] ${cause.message}`)),
    );
  });

const normalizeWakewordModelName = (modelName: string): string =>
  modelName.endsWith(".json") ? modelName.slice(0, -".json".length) : modelName;

const resolveDefaultSourceName = (): Effect.Effect<string, CliError, PulseAudioClient> =>
  Effect.gen(function* () {
    const client = yield* PulseAudioClient;

    yield* client.connect().pipe(
      Effect.mapError(
        (cause) =>
          new CliError({
            message: "Failed to connect to PulseAudio",
            cause,
          }),
      ),
    );

    const serverInfo = yield* client.getServerInfo.pipe(
      Effect.mapError(
        (cause) =>
          new CliError({
            message: "Failed to resolve default PulseAudio source",
            cause,
          }),
      ),
      Effect.ensuring(client.disconnect),
    );

    if (serverInfo.defaultSource.length === 0) {
      return yield* new CliError({
        message: "PulseAudio did not return a default capture source",
      });
    }

    return serverInfo.defaultSource;
  });

const runAssistantWakewordTranscribeLoop = (config: {
  readonly sourceName: string;
  readonly sttConfig: SttRuntimeConfig;
  readonly pttActiveRef: Ref.Ref<boolean>;
  readonly setRecordingMode: (
    mode: AssistantRecordingMode | undefined,
  ) => Effect.Effect<void, never>;
}): Effect.Effect<void, CliError, PulseAudioClient> =>
  Effect.gen(function* () {
    const assets = yield* validateWakewordAssets({
      wakewordModels: [DEFAULT_ASSISTANT_WAKEWORD_MODEL_FILE],
    }).pipe(
      Effect.mapError(
        (cause: WakewordAssetError) =>
          new CliError({
            message: `Wakeword assets are invalid: ${cause.message}`,
            cause,
          }),
      ),
    );

    const sessions = yield* loadWakewordModelSessions(assets).pipe(
      Effect.mapError(
        (cause: WakewordRuntimeError) =>
          new CliError({
            message: `Failed to initialize wakeword model sessions: ${cause.message}`,
            cause,
          }),
      ),
    );

    const pipeline = yield* makeWakewordPipeline(sessions).pipe(
      Effect.mapError(
        (cause: WakewordPipelineError) =>
          new CliError({
            message: `Failed to initialize wakeword inference pipeline: ${cause.message}`,
            cause,
          }),
      ),
    );

    const modelNames = Object.keys(assets.wakewordModelPaths);
    const selectedModelName =
      modelNames.find((name) => normalizeWakewordModelName(name) === "ok_pie") ?? modelNames[0];

    if (selectedModelName === undefined) {
      return yield* new CliError({
        message: "No wakeword models are available",
      });
    }

    const normalizedModelName = normalizeWakewordModelName(selectedModelName);
    const tuningPath = detectionTuningPathFor(normalizedModelName);
    const calibrationPath = calibrationPathFor(normalizedModelName);

    const tuningSnapshot = yield* readDetectionTuningSnapshot(tuningPath);
    const calibrationSnapshot = yield* readCalibrationSnapshot(calibrationPath);

    const triggerMachine = createWakewordTriggerMachine({
      threshold: tuningSnapshot?.trigger.threshold ?? 0.5,
      smoothingWindow: tuningSnapshot?.trigger.smoothingWindow ?? 4,
      consecutiveFrames: tuningSnapshot?.trigger.consecutiveFrames ?? 3,
      cooldownMs: tuningSnapshot?.trigger.cooldownMs ?? 1500,
    });

    const isTranscribingRef = yield* Ref.make(false);

    const wakewordRecordOptions = {
      sampleSpec: {
        format: PA_SAMPLE_FORMAT.S16LE,
        channels: 1,
        rate: DEFAULT_ASSISTANT_SAMPLE_RATE,
      },
      fragmentSize: DEFAULT_ASSISTANT_WAKEWORD_FRAGMENT_SIZE,
      sourceName: config.sourceName,
    } as const;

    yield* Console.log(
      `[assistant] Wakeword listener armed: model=${selectedModelName} source=${config.sourceName}`,
    );

    if (tuningSnapshot !== undefined) {
      yield* Console.log(`[assistant] Wakeword tuning loaded: ${tuningPath}`);
    }

    return yield* createWakewordTelemetryStream({
      pipeline,
      trigger: triggerMachine,
      recordStream: wakewordRecordOptions,
    }).pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          if (event.type !== "trigger" || event.event.model !== selectedModelName) {
            return;
          }

          const pttActive = yield* Ref.get(config.pttActiveRef);
          if (pttActive) {
            return;
          }

          const alreadyTranscribing = yield* Ref.get(isTranscribingRef);
          if (alreadyTranscribing) {
            return;
          }

          yield* Ref.set(isTranscribingRef, true);

          const triggerEffect = Effect.gen(function* () {
            const dictationSilenceSeconds =
              config.sttConfig.openrouter.wakewordDictationSilenceSeconds;
            const dictationMaxSeconds = config.sttConfig.openrouter.wakewordDictationMaxSeconds;
            const dictationSpeechStartTimeoutSeconds = resolveWakewordSpeechStartTimeoutSeconds({
              silenceSeconds: dictationSilenceSeconds,
              maxSeconds: dictationMaxSeconds,
            });
            const dictationSpeechRmsThreshold =
              calibrationSnapshot?.resolved.speechRms ??
              config.sttConfig.openrouter.wakewordDictationSpeechRmsThreshold;

            yield* Console.log(
              `[wakeword-transcribe] Trigger detected (${selectedModelName}). Dictation capture started (silence=${dictationSilenceSeconds}s, max=${dictationMaxSeconds}s, speech_start_timeout=${dictationSpeechStartTimeoutSeconds}s, speech_rms=${dictationSpeechRmsThreshold.toFixed(4)})...`,
            );

            yield* config.setRecordingMode("wakeword");

            const pcmBytes = yield* recordPcmUntilTrailingSilence({
              silenceSeconds: dictationSilenceSeconds,
              maxSeconds: dictationMaxSeconds,
              speechStartTimeoutSeconds: dictationSpeechStartTimeoutSeconds,
              speechRmsThreshold: dictationSpeechRmsThreshold,
              fragmentSize: DEFAULT_ASSISTANT_PTT_FRAGMENT_SIZE,
              sampleRate: DEFAULT_ASSISTANT_SAMPLE_RATE,
              channels: 1,
              sourceName: config.sourceName,
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new CliError({
                    message: "Failed to capture wakeword dictation clip",
                    cause,
                  }),
              ),
              Effect.ensuring(config.setRecordingMode(undefined)),
            );

            const transcript = yield* transcribePcmWithOpenRouter({
              model: config.sttConfig.openrouter.transcriptionModel,
              pcmBytes,
              sampleRate: DEFAULT_ASSISTANT_SAMPLE_RATE,
              language: config.sttConfig.openrouter.transcriptionLanguage,
            }).pipe(
              Effect.mapError(
                (cause: OpenRouterSttError) =>
                  new CliError({
                    message: `Wakeword transcription failed: ${cause.message}`,
                    cause,
                  }),
              ),
            );

            const text = transcript.trim();
            const injectableText = normalizeTextForInjection(text);

            if (injectableText.length === 0) {
              yield* Console.log("[wakeword-transcribe] Ignored empty transcript");
              return;
            }

            yield* Console.log("[wakeword-transcribe] Will type (start)");
            yield* Console.log(injectableText);
            yield* Console.log("[wakeword-transcribe] Will type (end)");

            const typed = yield* typeTextInFocusedApp(injectableText).pipe(
              Effect.mapError(
                (cause) =>
                  new CliError({
                    message:
                      cause instanceof Error
                        ? `Failed to type wakeword transcript: ${cause.message}`
                        : "Failed to type wakeword transcript",
                    cause,
                  }),
              ),
            );

            yield* Console.log(
              `[wakeword-transcribe] Typed ${typed.text.length} chars with ${typed.backend} (${typed.sessionType})`,
            );
          }).pipe(
            Effect.catch((cause: CliError) =>
              Console.log(`[wakeword-transcribe] ${cause.message}`),
            ),
            Effect.ensuring(Ref.set(isTranscribingRef, false)),
          );

          yield* Effect.forkDetach(triggerEffect);
        }),
      ),
      Effect.mapError(
        (cause) =>
          new CliError({
            message: "Wakeword listener failed",
            cause,
          }),
      ),
    );
  });

type AssistantPttMode = "transcribe" | "translate";

const runAssistantPttCombinedLoop = (config: {
  readonly sourceName: string;
  readonly sttConfig: SttRuntimeConfig;
  readonly pttActiveRef: Ref.Ref<boolean>;
  readonly setRecordingMode: (
    mode: AssistantRecordingMode | undefined,
  ) => Effect.Effect<void, never>;
}): Effect.Effect<never, PttKeyboardError, PulseAudioClient> =>
  Effect.scoped(
    Effect.gen(function* () {
      const sourceLanguage = config.sttConfig.openrouter.translationSourceLanguage;
      const targetLanguage = config.sttConfig.openrouter.translationTargetLanguage;

      yield* Console.log(
        `[assistant] PTT transcribe armed on keysym=${DEFAULT_ASSISTANT_PTT_TRANSCRIBE_KEYSYM} source=${config.sourceName}`,
      );
      yield* Console.log(
        `[assistant] PTT translate armed on keysym=${DEFAULT_ASSISTANT_PTT_TRANSLATE_KEYSYM} source=${config.sourceName} (${sourceLanguage} -> ${targetLanguage})`,
      );
      yield* Console.log(
        `PTT transcribe ready (keysym=${DEFAULT_ASSISTANT_PTT_TRANSCRIBE_KEYSYM}). Hold key to dictate.`,
      );
      yield* Console.log(
        `PTT translate ready (keysym=${DEFAULT_ASSISTANT_PTT_TRANSLATE_KEYSYM}, ${sourceLanguage} -> ${targetLanguage}). Hold key to dictate.`,
      );

      const keyboardBus = yield* connectKeyboardMonitorBus();

      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          keyboardBus.disconnect();
        }).pipe(Effect.ignore),
      );

      yield* callKeyboardMonitorMethod(keyboardBus, "WatchKeyboard");
      yield* Effect.addFinalizer(() =>
        callKeyboardMonitorMethod(keyboardBus, "UnwatchKeyboard").pipe(Effect.ignore),
      );

      const eventQueue = new AsyncEventQueue<KeyboardMonitorKeyEvent>();

      const onMessage = (message: DbusMessage): void => {
        const event = parseKeyboardMonitorSignal(message);
        if (event !== undefined) {
          eventQueue.push(event);
        }
      };

      keyboardBus.on("message", onMessage);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          keyboardBus.off("message", onMessage);
        }).pipe(Effect.ignore),
      );

      const captureActiveRef = yield* Ref.make(false);
      const captureModeRef = yield* Ref.make<AssistantPttMode | undefined>(undefined);
      const captureChunksRef = yield* Ref.make<ReadonlyArray<Uint8Array>>([]);
      const captureStartedAtRef = yield* Ref.make<number | undefined>(undefined);

      yield* Effect.addFinalizer(() =>
        Effect.all([Ref.set(config.pttActiveRef, false), config.setRecordingMode(undefined)], {
          discard: true,
        }),
      );

      const recordFiber = yield* createRecordStream({
        sampleSpec: {
          format: PA_SAMPLE_FORMAT.S16LE,
          channels: 1,
          rate: DEFAULT_ASSISTANT_SAMPLE_RATE,
        },
        fragmentSize: DEFAULT_ASSISTANT_PTT_FRAGMENT_SIZE,
        sourceName: config.sourceName,
      }).pipe(
        Stream.runForEach((chunk) =>
          Effect.gen(function* () {
            const active = yield* Ref.get(captureActiveRef);
            if (!active) {
              return;
            }

            const copied = chunk.slice();
            yield* Ref.update(captureChunksRef, (chunks) => {
              const next = chunks.slice();
              next.push(copied);
              return next;
            });
          }),
        ),
        Effect.forkDetach,
      );

      yield* Effect.addFinalizer(() => Fiber.interrupt(recordFiber).pipe(Effect.ignore));

      while (true) {
        const event = yield* Effect.promise(() => eventQueue.take());

        const mode: AssistantPttMode | undefined =
          event.keysym === DEFAULT_ASSISTANT_PTT_TRANSCRIBE_KEYSYM
            ? "transcribe"
            : event.keysym === DEFAULT_ASSISTANT_PTT_TRANSLATE_KEYSYM
              ? "translate"
              : undefined;

        if (mode === undefined) {
          continue;
        }

        const modePrefix =
          mode === "transcribe" ? "assistant-ptt-transcribe" : "assistant-ptt-translate";
        const recordingMode: AssistantRecordingMode =
          mode === "transcribe" ? "ptt-transcribe" : "ptt-translate";

        if (!event.released) {
          const alreadyActive = yield* Ref.get(captureActiveRef);
          if (alreadyActive) {
            continue;
          }

          yield* Ref.set(captureChunksRef, []);
          yield* Ref.set(captureStartedAtRef, Date.now());
          yield* Ref.set(captureModeRef, mode);
          yield* Ref.set(captureActiveRef, true);
          yield* Ref.set(config.pttActiveRef, true);
          yield* config.setRecordingMode(recordingMode);
          yield* Console.log(`[${modePrefix}] Capturing... release key to stop`);
          continue;
        }

        const wasActive = yield* Ref.get(captureActiveRef);
        if (!wasActive) {
          continue;
        }

        const activeMode = yield* Ref.get(captureModeRef);
        if (activeMode !== mode) {
          continue;
        }

        yield* Ref.set(captureActiveRef, false);
        yield* Ref.set(captureModeRef, undefined);
        yield* config.setRecordingMode(undefined);

        const startedAt = yield* Ref.get(captureStartedAtRef);
        yield* Ref.set(captureStartedAtRef, undefined);

        yield* Effect.gen(function* () {
          const durationMs = startedAt === undefined ? 0 : Date.now() - startedAt;
          const chunks = yield* Ref.get(captureChunksRef);
          yield* Ref.set(captureChunksRef, []);

          const capturedBytes = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
          yield* Console.log(
            `[${modePrefix}] Capture stopped (${durationMs}ms, ${capturedBytes} bytes)`,
          );

          if (durationMs < DEFAULT_ASSISTANT_MIN_DURATION_MS) {
            yield* Console.log(
              `[${modePrefix}] Ignored short clip (${durationMs}ms < ${DEFAULT_ASSISTANT_MIN_DURATION_MS}ms)`,
            );
            return;
          }

          const pcmBytes = concatChunks(chunks);
          if (pcmBytes.length === 0) {
            yield* Console.log(`[${modePrefix}] Ignored empty clip`);
            return;
          }

          if (mode === "transcribe") {
            const transcript = yield* transcribePcmWithOpenRouter({
              model: config.sttConfig.openrouter.transcriptionModel,
              pcmBytes,
              sampleRate: DEFAULT_ASSISTANT_SAMPLE_RATE,
              language: config.sttConfig.openrouter.transcriptionLanguage,
            }).pipe(
              Effect.mapError((cause: OpenRouterSttError) =>
                toPttKeyboardError(`PTT transcription failed: ${cause.message}`, cause),
              ),
            );

            const text = transcript.trim();
            const injectableText = normalizeTextForInjection(text);

            if (injectableText.length === 0) {
              yield* Console.log("[assistant-ptt-transcribe] Ignored empty transcript");
              return;
            }

            yield* Console.log("[assistant-ptt-transcribe] Will type (start)");
            yield* Console.log(injectableText);
            yield* Console.log("[assistant-ptt-transcribe] Will type (end)");

            const typed = yield* typeTextInFocusedApp(injectableText).pipe(
              Effect.mapError((cause) =>
                toPttKeyboardError(
                  cause instanceof Error
                    ? `Failed to type transcript text: ${cause.message}`
                    : "Failed to type transcript text",
                  cause,
                ),
              ),
            );

            yield* Console.log(
              `[assistant-ptt-transcribe] Typed ${typed.text.length} chars with ${typed.backend} (${typed.sessionType})`,
            );
            return;
          }

          const translated = yield* transcribeAndTranslatePcmWithOpenRouter({
            model: config.sttConfig.openrouter.translationModel,
            pcmBytes,
            sampleRate: DEFAULT_ASSISTANT_SAMPLE_RATE,
            sourceLanguage,
            targetLanguage,
          }).pipe(
            Effect.mapError((cause: OpenRouterSttError) =>
              toPttKeyboardError(`PTT translation failed: ${cause.message}`, cause),
            ),
          );

          const text = translated.trim();
          const injectableText = normalizeTextForInjection(text);

          if (injectableText.length === 0) {
            yield* Console.log("[assistant-ptt-translate] Ignored empty translation");
            return;
          }

          yield* Console.log("[assistant-ptt-translate] Will type (start)");
          yield* Console.log(injectableText);
          yield* Console.log("[assistant-ptt-translate] Will type (end)");

          const typed = yield* typeTextInFocusedApp(injectableText).pipe(
            Effect.mapError((cause) =>
              toPttKeyboardError(
                cause instanceof Error
                  ? `Failed to type translated text: ${cause.message}`
                  : "Failed to type translated text",
                cause,
              ),
            ),
          );

          yield* Console.log(
            `[assistant-ptt-translate] Typed ${typed.text.length} chars with ${typed.backend} (${typed.sessionType})`,
          );
        }).pipe(Effect.ensuring(Ref.set(config.pttActiveRef, false)));
      }
    }),
  );

const runAssistantDefaultCommand = Effect.gen(function* () {
  const sttConfig = yield* loadSttRuntimeConfig().pipe(
    Effect.mapError(
      (cause: SttConfigError) =>
        new CliError({
          message: `Failed to load STT config: ${cause.message}`,
          cause,
        }),
    ),
  );

  const sourceName = yield* resolveDefaultSourceName();
  const wakewordSpeechStartTimeoutSeconds = resolveWakewordSpeechStartTimeoutSeconds({
    silenceSeconds: sttConfig.openrouter.wakewordDictationSilenceSeconds,
    maxSeconds: sttConfig.openrouter.wakewordDictationMaxSeconds,
  });

  yield* Console.log("[assistant] Running default combined mode");
  yield* Console.log(
    `[assistant] Wakeword model=${DEFAULT_ASSISTANT_WAKEWORD_MODEL_FILE} -> transcription (${sttConfig.openrouter.transcriptionLanguage})`,
  );
  yield* Console.log(
    `[assistant] PTT transcribe keysym=${DEFAULT_ASSISTANT_PTT_TRANSCRIBE_KEYSYM}, PTT translate keysym=${DEFAULT_ASSISTANT_PTT_TRANSLATE_KEYSYM}`,
  );
  yield* Console.log(
    `[assistant] Wakeword dictation: silence=${sttConfig.openrouter.wakewordDictationSilenceSeconds}s max=${sttConfig.openrouter.wakewordDictationMaxSeconds}s speech_start_timeout=${wakewordSpeechStartTimeoutSeconds}s speech_rms=${sttConfig.openrouter.wakewordDictationSpeechRmsThreshold.toFixed(4)}`,
  );
  yield* Console.log("[assistant] Focus the target app (for example Slack) to receive typed text");
  yield* Console.log("[assistant] Press Ctrl+C to stop all listeners");

  const pttActiveRef = yield* Ref.make(false);
  const recordingStateRef = yield* Ref.make<AssistantRecordingRuntimeState>({
    mode: undefined,
    startedAtMs: undefined,
  });
  const setRecordingMode = (mode: AssistantRecordingMode | undefined) =>
    setAssistantRecordingMode({
      ref: recordingStateRef,
      mode,
    });

  yield* setRecordingMode(undefined);
  yield* Console.log(`[assistant] Recording state file: ${ASSISTANT_RECORDING_STATE_PATH}`);

  return yield* Effect.all(
    [
      runAssistantWakewordTranscribeLoop({ sourceName, sttConfig, pttActiveRef, setRecordingMode }),
      runAssistantPttCombinedLoop({ sourceName, sttConfig, pttActiveRef, setRecordingMode }),
    ],
    {
      concurrency: "unbounded",
      discard: true,
    },
  ).pipe(Effect.ensuring(setRecordingMode(undefined)));
});

const typeCommand = Command.make(
  "type",
  {
    text: Flag.string("text").pipe(Flag.withDescription("Text to type into the focused app")),
  },
  (config) =>
    Effect.gen(function* () {
      const result = yield* typeTextInFocusedApp(config.text);
      yield* Console.log(
        `Typed ${result.text.length} characters with ${result.backend} (${result.sessionType})`,
      );
    }),
).pipe(Command.withDescription("Spike command that types text via wtype/xdotool based on session"));

type AutoCalibrationResult = {
  readonly sourceName: string;
  readonly noiseRmsP95: number;
  readonly speechRmsP50: number;
  readonly speechRmsP80: number;
  readonly resolvedSpeechRms: number;
  readonly resolvedSpeechChunks: number;
  readonly resolvedPreRollMs: number;
  readonly resolvedMaxWaitSeconds: number;
};

const resolveTrainingSource = (config: {
  readonly requestedSourceName: string | undefined;
  readonly defaultSourceName: string;
  readonly availableSources: ReadonlyArray<SourceInfo>;
  readonly fragmentSize: number;
  readonly autoCalibrate: boolean;
}): Effect.Effect<string, WakewordTrainingError | CliError | Error, PulseAudioClient> =>
  Effect.gen(function* () {
    if (config.requestedSourceName !== undefined) {
      const exists = config.availableSources.some(
        (source) => source.name === config.requestedSourceName,
      );

      if (!exists) {
        return yield* new WakewordTrainingError({
          message: `Configured source '${config.requestedSourceName}' not found. Run 'npm run cli -- sources' and select one of the listed source names.`,
        });
      }

      return config.requestedSourceName;
    }

    const defaultSource =
      config.availableSources.find((source) => source.name === config.defaultSourceName) ??
      config.availableSources[0];

    if (defaultSource === undefined || defaultSource.name === null) {
      return yield* new WakewordTrainingError({
        message: "No capture source is available in PulseAudio",
      });
    }

    if (!config.autoCalibrate) {
      return defaultSource.name;
    }

    const defaultLooksLikeMonitor = isMonitorSource(defaultSource);

    if (!defaultLooksLikeMonitor) {
      const defaultProbe = yield* collectAudioMetricsInteractive({
        fragmentSize: config.fragmentSize,
        sampleRate: 16_000,
        channels: 1,
        sourceName: defaultSource.name,
        startPrompt: [
          `Auto source check on '${defaultSource.name}'`,
          "Press Enter to start capture, then say the wake phrase once.",
        ].join("\n"),
        stopPrompt: "Press Enter to stop source check and continue.",
      });

      if (defaultProbe.maxRms >= 0.004) {
        yield* Console.log(
          `Auto source selected default '${defaultSource.name}' (max RMS ${defaultProbe.maxRms.toFixed(4)})`,
        );
        return defaultSource.name;
      }

      yield* Console.log(
        `Default source '${defaultSource.name}' looks weak (max RMS ${defaultProbe.maxRms.toFixed(4)}). Probing alternatives...`,
      );
    } else {
      yield* Console.log(
        `Default source '${defaultSource.name}' is a monitor source. Probing microphone sources...`,
      );
    }

    const candidates = config.availableSources.filter(
      (source) => source.name !== null && !isMonitorSource(source),
    );

    if (candidates.length === 0) {
      yield* Console.log(
        "No non-monitor capture sources found; falling back to default source from PulseAudio",
      );
      return defaultSource.name;
    }

    yield* Console.log("Sequential source probe: each source waits for start/stop confirmation");

    let bestSource = defaultSource.name;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      const candidateName = candidate.name;

      if (candidateName === null) {
        continue;
      }

      const metrics = yield* collectAudioMetricsInteractive({
        fragmentSize: config.fragmentSize,
        sampleRate: 16_000,
        channels: 1,
        sourceName: candidateName,
        startPrompt: [
          `[source probe ${index + 1}/${candidates.length}] ${candidateName}`,
          "Press Enter to start probe, then say wake phrase once.",
        ].join("\n"),
        stopPrompt: "Press Enter to stop this probe and continue.",
      });

      const score = sourceProbeScore(metrics);
      yield* Console.log(
        `[source probe ${index + 1}/${candidates.length}] max_rms=${metrics.maxRms.toFixed(4)} p95=${metrics.rmsP95.toFixed(4)} score=${score.toFixed(4)}`,
      );

      if (score > bestScore) {
        bestScore = score;
        bestSource = candidateName;
      }
    }

    yield* Console.log(`Auto source selected: ${bestSource}`);
    return bestSource;
  });

const runAutoCalibration = (config: {
  readonly sourceName: string;
  readonly fragmentSize: number;
  readonly wakePhrase: string;
}): Effect.Effect<AutoCalibrationResult, Error | WakewordTrainingError, PulseAudioClient> =>
  Effect.gen(function* () {
    const noise = yield* collectAudioMetricsInteractive({
      fragmentSize: config.fragmentSize,
      sampleRate: 16_000,
      channels: 1,
      sourceName: config.sourceName,
      startPrompt: [
        "Calibration step 1/2: noise floor",
        "Stay quiet.",
        "Press Enter to start noise capture.",
      ].join("\n"),
      stopPrompt: "Press Enter to stop noise capture.",
    });

    yield* Console.log(
      `Calibration noise floor: p95=${noise.rmsP95.toFixed(4)} max=${noise.maxRms.toFixed(4)}`,
    );

    const speech = yield* collectAudioMetricsInteractive({
      fragmentSize: config.fragmentSize,
      sampleRate: 16_000,
      channels: 1,
      sourceName: config.sourceName,
      startPrompt: [
        "Calibration step 2/2: speech level",
        `Say '${config.wakePhrase}' a few times.`,
        "Press Enter to start speech capture.",
      ].join("\n"),
      stopPrompt: "Press Enter to stop speech capture and continue.",
    });

    const noiseGate = Math.max(0.0005, noise.rmsP95 * 1.2);
    const activeSpeech = speech.rmsValues.filter((value) => value >= noiseGate);
    const speechPopulation = activeSpeech.length > 0 ? activeSpeech : speech.rmsValues;

    const speechRmsP50 = percentile(speechPopulation, 0.5);
    const speechRmsP80 = percentile(speechPopulation, 0.8);

    const resolvedSpeechRms = clamp(Math.max(noise.rmsP95 * 2.5, speechRmsP50 * 0.45), 0.001, 0.03);

    const chunkDurationMs = (config.fragmentSize / (16_000 * 1 * 2)) * 1000;
    const resolvedSpeechChunks = Math.max(1, Math.min(6, Math.round(90 / chunkDurationMs)));

    return {
      sourceName: config.sourceName,
      noiseRmsP95: noise.rmsP95,
      speechRmsP50,
      speechRmsP80,
      resolvedSpeechRms,
      resolvedSpeechChunks,
      resolvedPreRollMs: 300,
      resolvedMaxWaitSeconds: 12,
    };
  });

const wakewordCommand = Command.make(
  "wakeword",
  {
    duration: positiveIntegerFlag("duration", "How long to listen for wakeword events", 20),
    threshold: optionalBoundedFloatFlag("threshold", "Trigger threshold (0.0 to 1.0)", 0, 1),
    smoothingWindow: optionalPositiveIntegerFlag(
      "smoothing-window",
      "Smoothing window size in frames",
    ),
    consecutiveFrames: optionalPositiveIntegerFlag(
      "consecutive-frames",
      "Minimum smoothed frames over threshold before trigger",
    ),
    cooldownMs: optionalPositiveIntegerFlag(
      "cooldown-ms",
      "Cooldown after trigger in milliseconds",
    ),
    noAutoTune: Flag.boolean("no-auto-tune").pipe(
      Flag.withDescription(
        "Disable loading saved tuning from $XDG_CONFIG_HOME/pie/wakeword/<model>/detection-tuning.json (legacy effect-pi dir is preferred when present)",
      ),
    ),
    scoreEvery: positiveIntegerFlag(
      "score-every",
      "Print score snapshots every N scored frames",
      5,
    ),
    fragmentSize: positiveIntegerFlag("fragment-size", "PulseAudio fragment size in bytes", 1024),
    source: optionalSourceFlag,
    assetRoot: Flag.string("asset-root").pipe(
      Flag.optional,
      Flag.withDescription("Override wakeword asset root directory"),
    ),
    models: Flag.string("models").pipe(
      Flag.optional,
      Flag.withDescription("Comma-separated wakeword model file names"),
    ),
  },
  (config) =>
    Effect.gen(function* () {
      const wakewordModels = Option.isSome(config.models)
        ? config.models.value
            .split(",")
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0)
        : undefined;

      const assetOptions: {
        rootDir?: string;
        wakewordModels?: ReadonlyArray<string>;
      } = {};

      if (Option.isSome(config.assetRoot)) {
        assetOptions.rootDir = config.assetRoot.value;
      }

      if (wakewordModels !== undefined && wakewordModels.length > 0) {
        assetOptions.wakewordModels = wakewordModels;
      }

      const assets = yield* validateWakewordAssets(assetOptions).pipe(
        Effect.mapError(
          (cause: WakewordAssetError) =>
            new CliError({
              message: `Wakeword assets are invalid: ${cause.message}`,
              cause,
            }),
        ),
      );

      const sessions = yield* loadWakewordModelSessions(assets).pipe(
        Effect.mapError(
          (cause: WakewordRuntimeError) =>
            new CliError({
              message: `Failed to initialize wakeword model sessions: ${cause.message}`,
              cause,
            }),
        ),
      );

      const pipeline = yield* makeWakewordPipeline(sessions).pipe(
        Effect.mapError(
          (cause: WakewordPipelineError) =>
            new CliError({
              message: `Failed to initialize wakeword inference pipeline: ${cause.message}`,
              cause,
            }),
        ),
      );

      const modelNames = Object.keys(assets.wakewordModelPaths);
      const tuningModelName = modelNames.length === 1 ? modelNames[0] : undefined;
      const tuningPath =
        tuningModelName === undefined ? undefined : detectionTuningPathFor(tuningModelName);

      const tuningSnapshot =
        config.noAutoTune || tuningPath === undefined
          ? undefined
          : yield* readDetectionTuningSnapshot(tuningPath);

      const resolvedThreshold = Option.isSome(config.threshold)
        ? config.threshold.value
        : (tuningSnapshot?.trigger.threshold ?? 0.5);
      const resolvedSmoothingWindow = Option.isSome(config.smoothingWindow)
        ? config.smoothingWindow.value
        : (tuningSnapshot?.trigger.smoothingWindow ?? 4);
      const resolvedConsecutiveFrames = Option.isSome(config.consecutiveFrames)
        ? config.consecutiveFrames.value
        : (tuningSnapshot?.trigger.consecutiveFrames ?? 3);
      const resolvedCooldownMs = Option.isSome(config.cooldownMs)
        ? config.cooldownMs.value
        : (tuningSnapshot?.trigger.cooldownMs ?? 1500);

      if (tuningSnapshot !== undefined && tuningPath !== undefined) {
        yield* Console.log(`Loaded wakeword tuning from ${tuningPath}`);
      }

      yield* Console.log(
        `Trigger tuning: threshold=${resolvedThreshold.toFixed(3)} smoothing_window=${resolvedSmoothingWindow} consecutive_frames=${resolvedConsecutiveFrames} cooldown_ms=${resolvedCooldownMs}`,
      );

      const triggerMachine = createWakewordTriggerMachine({
        threshold: resolvedThreshold,
        smoothingWindow: resolvedSmoothingWindow,
        consecutiveFrames: resolvedConsecutiveFrames,
        cooldownMs: resolvedCooldownMs,
      });

      const scoreCounter = yield* Ref.make(0);

      yield* Console.log(
        `Listening for wakewords (${Object.keys(assets.wakewordModelPaths).join(", ")}) for ${config.duration}s...`,
      );

      const wakewordRecordOptions: {
        sampleSpec: {
          format: PA_SAMPLE_FORMAT;
          channels: number;
          rate: number;
        };
        fragmentSize: number;
        sourceName?: string;
      } = {
        sampleSpec: {
          format: PA_SAMPLE_FORMAT.S16LE,
          channels: 1,
          rate: 16_000,
        },
        fragmentSize: config.fragmentSize,
      };

      const resolvedSourceName = yield* Effect.gen(function* () {
        if (Option.isSome(config.source)) {
          return config.source.value;
        }

        const client = yield* PulseAudioClient;
        yield* client.connect();

        const serverInfo = yield* client.getServerInfo.pipe(Effect.ensuring(client.disconnect));

        return serverInfo.defaultSource;
      });

      if (resolvedSourceName.length > 0) {
        wakewordRecordOptions.sourceName = resolvedSourceName;
      }

      yield* Console.log(
        `Wakeword source: ${wakewordRecordOptions.sourceName ?? "@DEFAULT_SOURCE@"}`,
      );

      const telemetryFiber = yield* createWakewordTelemetryStream({
        pipeline,
        trigger: triggerMachine,
        recordStream: wakewordRecordOptions,
      }).pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            if (event.type === "score") {
              const trackedModels = Object.keys(event.frame.scores);
              if (trackedModels.length === 0) {
                return;
              }

              const frameIndex = yield* Ref.updateAndGet(scoreCounter, (count) => count + 1);
              if (frameIndex % config.scoreEvery !== 0) {
                return;
              }

              const formattedScores = Object.entries(event.frame.scores)
                .map(([model, score]) => `${model}=${score.toFixed(6)}`)
                .join(" ");

              yield* Console.log(
                `[score t=${event.frame.timestampMs.toFixed(0)}ms] ${formattedScores}`,
              );
              return;
            }

            yield* Console.log(
              `[trigger t=${event.event.timestampMs.toFixed(0)}ms] ${event.event.model} score=${event.event.score.toFixed(3)} raw=${event.event.rawScore.toFixed(3)}`,
            );
          }),
        ),
        Effect.forkDetach,
      );

      yield* Effect.sleep(`${config.duration} seconds`);
      yield* Fiber.interrupt(telemetryFiber);
      yield* Console.log("Wakeword session complete");
    }),
).pipe(Command.withDescription("Run live openWakeWord detection on PulseAudio input"));

const wakewordTuneCommand = Command.make(
  "wakeword-tune",
  {
    model: Flag.string("model").pipe(
      Flag.optional,
      Flag.withDescription("Wakeword model file to tune (for example: ok_pie.json)"),
    ),
    wakePhrase: Flag.string("wake-phrase").pipe(
      Flag.optional,
      Flag.withDescription(
        "Wake phrase spoken during positive calibration (defaults to model name)",
      ),
    ),
    expectedRepeats: optionalPositiveIntegerFlag(
      "expected-repeats",
      "Expected wake phrase repetitions in positive step (auto by default)",
    ),
    fragmentSize: positiveIntegerFlag("fragment-size", "PulseAudio fragment size in bytes", 1024),
    source: optionalSourceFlag,
    assetRoot: Flag.string("asset-root").pipe(
      Flag.optional,
      Flag.withDescription("Override wakeword asset root directory"),
    ),
    noSave: Flag.boolean("no-save").pipe(
      Flag.withDescription("Do not save detected trigger tuning snapshot"),
    ),
  },
  (config) =>
    Effect.gen(function* () {
      const requestedModel = Option.isSome(config.model) ? config.model.value : undefined;

      const assetOptions: {
        rootDir?: string;
        wakewordModels?: ReadonlyArray<string>;
      } = {};

      if (Option.isSome(config.assetRoot)) {
        assetOptions.rootDir = config.assetRoot.value;
      }

      if (requestedModel !== undefined) {
        assetOptions.wakewordModels = [requestedModel];
      }

      const assets = yield* validateWakewordAssets(assetOptions).pipe(
        Effect.mapError(
          (cause: WakewordAssetError) =>
            new CliError({
              message: `Wakeword assets are invalid: ${cause.message}`,
              cause,
            }),
        ),
      );

      const sessions = yield* loadWakewordModelSessions(assets).pipe(
        Effect.mapError(
          (cause: WakewordRuntimeError) =>
            new CliError({
              message: `Failed to initialize wakeword model sessions: ${cause.message}`,
              cause,
            }),
        ),
      );

      const modelNames = Object.keys(assets.wakewordModelPaths);
      if (modelNames.length === 0) {
        return yield* new CliError({
          message: "No wakeword model is available for tuning",
        });
      }

      const preferredModelName =
        requestedModel !== undefined
          ? modelNames[0]
          : (modelNames.find((name) => name !== "default") ?? modelNames[0]);

      const modelName = preferredModelName ?? "default";
      const modelPath = assets.wakewordModelPaths[modelName] ?? `${modelName}.json`;
      const modelFile = path.basename(modelPath);

      if (requestedModel === undefined && modelNames.length > 1) {
        yield* Console.log(
          `wakeword-tune: multiple models found (${modelNames.join(", ")}), auto-selecting '${modelName}'. Use --model to pick a specific model.`,
        );
      }

      const wakePhrase = Option.isSome(config.wakePhrase)
        ? config.wakePhrase.value
        : modelName.replace(/_/g, " ");

      const client = yield* PulseAudioClient;
      yield* client.connect();

      const tuning = yield* Effect.gen(function* () {
        const serverInfo = yield* client.getServerInfo;
        const sources = yield* client.listSources;

        const resolvedSourceName = Option.isSome(config.source)
          ? config.source.value
          : serverInfo.defaultSource;

        if (!sources.some((source) => source.name === resolvedSourceName)) {
          return yield* new CliError({
            message: `Configured source '${resolvedSourceName}' not found. Run 'npm run cli -- sources' and choose one source name.`,
          });
        }

        yield* Console.log(`Wakeword tuning model: ${modelName} (${modelFile})`);
        yield* Console.log(`Wakeword tuning source: ${resolvedSourceName}`);
        yield* Console.log("Tuning uses three interactive phases.");
        yield* Console.log(
          "You can capture as long as needed in each phase before pressing Enter.",
        );

        const silenceFrames = yield* collectWakewordScoresInteractive({
          sessions,
          modelName,
          sourceName: resolvedSourceName,
          fragmentSize: config.fragmentSize,
          startPrompt: [
            "Step 1/3: background baseline",
            "Stay quiet.",
            "Press Enter to start baseline capture.",
          ].join("\n"),
          stopPrompt: "Press Enter to stop baseline capture.",
        });

        const negativeFrames = yield* collectWakewordScoresInteractive({
          sessions,
          modelName,
          sourceName: resolvedSourceName,
          fragmentSize: config.fragmentSize,
          startPrompt: [
            "Step 2/3: non-wakeword speech",
            `Speak normally, but DO NOT say '${wakePhrase}'.`,
            "Press Enter to start negative capture.",
          ].join("\n"),
          stopPrompt: "Press Enter to stop negative capture.",
        });

        const positiveFrames = yield* collectWakewordScoresInteractive({
          sessions,
          modelName,
          sourceName: resolvedSourceName,
          fragmentSize: config.fragmentSize,
          startPrompt: [
            "Step 3/3: wakeword positives",
            `Say '${wakePhrase}' repeatedly, with small pauses.`,
            "Press Enter to start positive capture.",
          ].join("\n"),
          stopPrompt: "Press Enter to stop positive capture and compute tuning.",
        });

        const silenceScores = silenceFrames.map((frame) => frame.score);
        const negativeScores = negativeFrames.map((frame) => frame.score);
        const positiveScores = positiveFrames.map((frame) => frame.score);

        const silenceStats = summarizeScores(silenceScores);
        const negativeStats = summarizeScores(negativeScores);
        const positiveStats = summarizeScores(positiveScores);

        const estimatedRepeats = estimateWakePhraseCount(positiveFrames);
        const targetPositiveTriggers = Option.isSome(config.expectedRepeats)
          ? config.expectedRepeats.value
          : Math.max(1, estimatedRepeats);

        const evaluation = evaluateTriggerTuning({
          modelName,
          silenceFrames,
          negativeFrames,
          positiveFrames,
          targetPositiveTriggers,
        });

        yield* Console.log(
          `Score stats: silence p99=${silenceStats.p99.toFixed(4)} negative p99=${negativeStats.p99.toFixed(4)} positive p90=${positiveStats.p90.toFixed(4)} positive max=${positiveStats.max.toFixed(4)}`,
        );
        yield* Console.log(
          `Estimated wake phrase count=${estimatedRepeats} target_triggers=${evaluation.targetPositiveTriggers}`,
        );

        return {
          sourceName: resolvedSourceName,
          silenceStats,
          negativeStats,
          positiveStats,
          estimatedRepeats,
          evaluation,
        };
      }).pipe(Effect.ensuring(client.disconnect));

      const tuned = tuning.evaluation.config;
      yield* Console.log(
        `Recommended trigger: threshold=${tuned.threshold.toFixed(3)} smoothing_window=${tuned.smoothingWindow} consecutive_frames=${tuned.consecutiveFrames} cooldown_ms=${tuned.cooldownMs}`,
      );
      yield* Console.log(
        `Calibration quality: positive_triggers=${tuning.evaluation.positiveTriggers}/${tuning.evaluation.targetPositiveTriggers} negative_triggers=${tuning.evaluation.negativeTriggers} silence_triggers=${tuning.evaluation.silenceTriggers}`,
      );

      if (!config.noSave) {
        const tuningPath = detectionTuningPathFor(modelName);

        yield* writeDetectionTuningSnapshot(tuningPath, {
          schemaVersion: 1,
          createdAt: new Date().toISOString(),
          sourceName: tuning.sourceName,
          modelName,
          modelFile,
          trigger: tuned,
          metrics: {
            silenceP99: tuning.silenceStats.p99,
            negativeP99: tuning.negativeStats.p99,
            positiveP90: tuning.positiveStats.p90,
            positiveEstimatedPhrases: tuning.estimatedRepeats,
            positiveTriggers: tuning.evaluation.positiveTriggers,
            negativeTriggers: tuning.evaluation.negativeTriggers,
            silenceTriggers: tuning.evaluation.silenceTriggers,
          },
        });

        yield* Console.log(`Saved tuning snapshot: ${tuningPath}`);
        yield* Console.log(
          "wakeword command will auto-load this tuning unless --no-auto-tune is set.",
        );
      }

      yield* Console.log(
        `Try now: npm run cli -- wakeword --models ${modelFile} --source ${tuning.sourceName} --duration 30`,
      );
    }),
).pipe(
  Command.withDescription(
    "Interactive wakeword trigger auto-tuning (captures silence, non-wake speech, and wake phrase repeats)",
  ),
);

const wakewordTrainCommand = Command.make(
  "wakeword-train",
  {
    name: Flag.string("name").pipe(
      Flag.withDescription("Custom wakeword name (model file will be <name>.json)"),
    ),
    positiveCount: positiveIntegerFlag("positive-count", "Number of positive clips to collect", 12),
    negativeCount: positiveIntegerFlag("negative-count", "Number of negative clips to collect", 20),
    clipSeconds: boundedFloatFlag("clip-seconds", "Clip duration in seconds", 1.2, 0.4, 6),
    gapMs: positiveIntegerFlag("gap-ms", "Pause between clips in milliseconds", 600),
    fragmentSize: positiveIntegerFlag("fragment-size", "PulseAudio fragment size in bytes", 1024),
    maxWaitSeconds: optionalPositiveIntegerFlag(
      "max-wait-seconds",
      "Max seconds to wait for speech before retry (auto by default)",
    ),
    retryLimit: positiveIntegerFlag(
      "retry-limit",
      "Retries per positive clip when no speech is detected",
      3,
    ),
    speechRms: optionalBoundedFloatFlag(
      "speech-rms",
      "RMS threshold for speech detection (0.001-0.2, auto by default)",
      0.001,
      0.2,
    ),
    speechChunks: optionalPositiveIntegerFlag(
      "speech-chunks",
      "Consecutive chunks above threshold to start clip (auto by default)",
    ),
    preRollMs: optionalPositiveIntegerFlag(
      "pre-roll-ms",
      "Audio to include before speech trigger in milliseconds (auto by default)",
    ),
    noAutoCalibrate: Flag.boolean("no-auto-calibrate").pipe(
      Flag.withDescription("Disable automatic source and RMS calibration"),
    ),
    recalibrate: Flag.boolean("recalibrate").pipe(
      Flag.withDescription("Ignore saved calibration snapshot and calibrate again"),
    ),
    source: optionalSourceFlag,
    assetRoot: Flag.string("asset-root").pipe(
      Flag.optional,
      Flag.withDescription(
        "Root openWakeWord asset directory (default: $XDG_DATA_HOME/pie/openwakeword; legacy effect-pi dir preferred when present)",
      ),
    ),
    datasetRoot: Flag.string("dataset-root").pipe(
      Flag.optional,
      Flag.withDescription("Override training dataset root directory"),
    ),
    outputDir: Flag.string("output-dir").pipe(
      Flag.optional,
      Flag.withDescription("Override trained wakeword model output directory"),
    ),
    register: Flag.boolean("register").pipe(
      Flag.withDescription(
        "Add generated model filename to $XDG_DATA_HOME/pie/openwakeword/manifest.json (legacy effect-pi dir preferred when present)",
      ),
    ),
  },
  (config) =>
    Effect.gen(function* () {
      const trainingOptions: {
        name: string;
        assetRootDir?: string;
        datasetRootDir?: string;
        outputDir?: string;
      } = {
        name: config.name,
      };

      if (Option.isSome(config.assetRoot)) {
        trainingOptions.assetRootDir = config.assetRoot.value;
      }

      if (Option.isSome(config.datasetRoot)) {
        trainingOptions.datasetRootDir = config.datasetRoot.value;
      }

      if (Option.isSome(config.outputDir)) {
        trainingOptions.outputDir = config.outputDir.value;
      }

      const plan = yield* Effect.try({
        try: () => makeWakewordTrainingPlan(trainingOptions),
        catch: (cause) =>
          cause instanceof WakewordTrainingError
            ? cause
            : new WakewordTrainingError({
                message: "Failed to build wakeword training plan",
                cause,
              }),
      });

      yield* initializeWakewordTrainingWorkspace(plan);

      const assets = yield* validateWakewordAssets({
        rootDir: plan.assetRootDir,
        validateWakewordModels: false,
      }).pipe(
        Effect.mapError(
          (cause: WakewordAssetError) =>
            new WakewordTrainingError({
              message: `Wakeword feature assets are invalid: ${cause.message}`,
              cause,
            }),
        ),
      );

      const featureSessions = yield* loadWakewordFeatureSessions(assets).pipe(
        Effect.mapError(
          (cause: WakewordRuntimeError) =>
            new WakewordTrainingError({
              message: `Failed to initialize feature models: ${cause.message}`,
              cause,
            }),
        ),
      );

      const requestedSourceName = Option.isSome(config.source) ? config.source.value : undefined;
      const autoCalibrate = !config.noAutoCalibrate;
      const calibrationPath = calibrationPathFor(plan.modelName);

      const client = yield* PulseAudioClient;
      yield* client.connect();

      const { positiveClips, negativeClips } = yield* Effect.gen(function* () {
        const serverInfo = yield* client.getServerInfo;
        const availableSources = yield* client.listSources;

        const selectedSourceName = yield* resolveTrainingSource({
          requestedSourceName,
          defaultSourceName: serverInfo.defaultSource,
          availableSources,
          fragmentSize: config.fragmentSize,
          autoCalibrate,
        });

        const wakePhrase = plan.modelName.replace(/_/g, " ");

        const savedCalibration =
          autoCalibrate && !config.recalibrate
            ? yield* readCalibrationSnapshot(calibrationPath)
            : undefined;

        const calibrationResult =
          autoCalibrate &&
          (savedCalibration === undefined || savedCalibration.sourceName !== selectedSourceName)
            ? yield* runAutoCalibration({
                sourceName: selectedSourceName,
                fragmentSize: config.fragmentSize,
                wakePhrase,
              })
            : savedCalibration === undefined
              ? undefined
              : {
                  sourceName: savedCalibration.sourceName,
                  noiseRmsP95: savedCalibration.noiseRmsP95,
                  speechRmsP50: savedCalibration.speechRmsP50,
                  speechRmsP80: savedCalibration.speechRmsP80,
                  resolvedSpeechRms: savedCalibration.resolved.speechRms,
                  resolvedSpeechChunks: savedCalibration.resolved.speechChunks,
                  resolvedPreRollMs: savedCalibration.resolved.preRollMs,
                  resolvedMaxWaitSeconds: savedCalibration.resolved.maxWaitSeconds,
                };

        if (
          autoCalibrate &&
          calibrationResult !== undefined &&
          (savedCalibration === undefined || savedCalibration.sourceName !== selectedSourceName)
        ) {
          yield* writeCalibrationSnapshot(calibrationPath, {
            schemaVersion: 1,
            createdAt: new Date().toISOString(),
            sourceName: calibrationResult.sourceName,
            noiseRmsP95: calibrationResult.noiseRmsP95,
            speechRmsP50: calibrationResult.speechRmsP50,
            speechRmsP80: calibrationResult.speechRmsP80,
            resolved: {
              speechRms: calibrationResult.resolvedSpeechRms,
              speechChunks: calibrationResult.resolvedSpeechChunks,
              preRollMs: calibrationResult.resolvedPreRollMs,
              maxWaitSeconds: calibrationResult.resolvedMaxWaitSeconds,
            },
          });
        }

        const resolvedSpeechRms = Option.isSome(config.speechRms)
          ? config.speechRms.value
          : (calibrationResult?.resolvedSpeechRms ?? 0.015);
        const resolvedSpeechChunks = Option.isSome(config.speechChunks)
          ? config.speechChunks.value
          : (calibrationResult?.resolvedSpeechChunks ?? 2);
        const resolvedPreRollMs = Option.isSome(config.preRollMs)
          ? config.preRollMs.value
          : (calibrationResult?.resolvedPreRollMs ?? 250);
        const resolvedMaxWaitSeconds = Option.isSome(config.maxWaitSeconds)
          ? config.maxWaitSeconds.value
          : (calibrationResult?.resolvedMaxWaitSeconds ?? 8);
        const noiseFloorRms =
          calibrationResult?.noiseRmsP95 ?? Math.max(0.0005, resolvedSpeechRms * 0.2);

        yield* Console.log(`Training capture source: ${selectedSourceName}`);

        if (savedCalibration !== undefined && savedCalibration.sourceName === selectedSourceName) {
          yield* Console.log(`Loaded calibration snapshot: ${calibrationPath}`);
        } else if (calibrationResult !== undefined) {
          yield* Console.log(`Saved calibration snapshot: ${calibrationPath}`);
        }

        yield* Console.log(
          `Capture tuning: speech_rms=${resolvedSpeechRms.toFixed(4)} speech_chunks=${resolvedSpeechChunks} pre_roll_ms=${resolvedPreRollMs} max_wait_seconds=${resolvedMaxWaitSeconds}`,
        );

        const speechRmsRef = yield* Ref.make(resolvedSpeechRms);
        const positiveClips: Array<Uint8Array> = [];
        const negativeClips: Array<Uint8Array> = [];

        yield* Console.log(
          `Collecting ${config.positiveCount} positive clips for '${plan.modelName}'`,
        );
        for (let index = 0; index < config.positiveCount; index += 1) {
          const clipNumber = index + 1;

          const collectPositiveAttempt = (
            attempt: number,
          ): Effect.Effect<Uint8Array, Error, PulseAudioClient> =>
            Effect.gen(function* () {
              const currentSpeechRms = yield* Ref.get(speechRmsRef);

              yield* Console.log(
                `[positive ${clipNumber}/${config.positiveCount} attempt ${attempt}/${config.retryLimit}] Say '${wakePhrase}' (waiting for speech, rms=${currentSpeechRms.toFixed(4)})`,
              );

              const clip = yield* recordVoiceActivatedClip({
                clipSeconds: config.clipSeconds,
                maxWaitSeconds: resolvedMaxWaitSeconds,
                speechRmsThreshold: currentSpeechRms,
                minActiveChunks: resolvedSpeechChunks,
                preRollMs: resolvedPreRollMs,
                fragmentSize: config.fragmentSize,
                sampleRate: 16_000,
                channels: 1,
                sourceName: selectedSourceName,
              });

              const clipRms = pcmRms(clip);
              const clipPeak = pcmPeak(clip);
              const minClipRms = Math.max(noiseFloorRms * 2.5, currentSpeechRms * 0.9, 0.003);
              const minClipPeak = Math.max(minClipRms * 3, 0.01);

              if (clipRms < minClipRms || clipPeak < minClipPeak) {
                return yield* new NoSpeechDetectedError({
                  message: `Captured clip is too quiet (rms ${clipRms.toFixed(4)}, peak ${clipPeak.toFixed(4)}; expected at least rms ${minClipRms.toFixed(4)}, peak ${minClipPeak.toFixed(4)})`,
                  observedMaxRms: clipRms,
                  threshold: minClipRms,
                });
              }

              return clip;
            }).pipe(
              Effect.catchIf(
                (error): error is NoSpeechDetectedError => error instanceof NoSpeechDetectedError,
                (error) =>
                  Effect.gen(function* () {
                    const speechRmsLocked = Option.isSome(config.speechRms);
                    const currentSpeechRms = yield* Ref.get(speechRmsRef);
                    const floor = Math.max(0.001, noiseFloorRms * 1.5);
                    const suggestedThreshold = Math.max(floor, error.observedMaxRms * 0.85);

                    if (!speechRmsLocked) {
                      const loweredThreshold = clamp(
                        Math.min(currentSpeechRms * 0.9, suggestedThreshold),
                        floor,
                        0.2,
                      );

                      if (loweredThreshold < currentSpeechRms) {
                        yield* Ref.set(speechRmsRef, loweredThreshold);
                        yield* Console.log(
                          `[positive ${clipNumber}/${config.positiveCount}] Auto-adjusted speech-rms ${currentSpeechRms.toFixed(4)} -> ${loweredThreshold.toFixed(4)}`,
                        );
                      }
                    }

                    if (attempt >= config.retryLimit) {
                      const effectiveSpeechRms = yield* Ref.get(speechRmsRef);
                      return yield* new WakewordTrainingError({
                        message: `[positive ${clipNumber}/${config.positiveCount}] ${error.message}. Final speech-rms was ${effectiveSpeechRms.toFixed(4)}. Run 'npm run cli -- meter --source ${selectedSourceName}' to inspect live levels.`,
                      });
                    }

                    const nextSpeechRms = yield* Ref.get(speechRmsRef);

                    return yield* Console.log(
                      `[positive ${clipNumber}/${config.positiveCount}] ${error.message}. Retrying... (next speech-rms ${nextSpeechRms.toFixed(4)})`,
                    ).pipe(Effect.andThen(collectPositiveAttempt(attempt + 1)));
                  }),
              ),
            );

          const clip = yield* collectPositiveAttempt(1);
          yield* Console.log(
            `[positive ${clipNumber}/${config.positiveCount}] accepted clip rms=${pcmRms(clip).toFixed(4)} peak=${pcmPeak(clip).toFixed(4)}`,
          );

          positiveClips.push(clip);
          const outputPath = `${plan.positiveDir}/positive-${String(clipNumber).padStart(3, "0")}.wav`;
          yield* writePcmWavFile(outputPath, clip);
          yield* Effect.sleep(`${config.gapMs} millis`);
        }

        yield* Console.log(
          `Collecting ${config.negativeCount} negative clips (do not say wake phrase)`,
        );
        for (let index = 0; index < config.negativeCount; index += 1) {
          const clipNumber = index + 1;
          yield* Console.log(
            `[negative ${clipNumber}/${config.negativeCount}] Speak anything else or stay silent`,
          );
          yield* Effect.sleep("300 millis");

          const clip = yield* recordPcmClip({
            durationSeconds: config.clipSeconds,
            fragmentSize: config.fragmentSize,
            sampleRate: 16_000,
            channels: 1,
            sourceName: selectedSourceName,
          });

          negativeClips.push(clip);
          const outputPath = `${plan.negativeDir}/negative-${String(clipNumber).padStart(3, "0")}.wav`;
          yield* writePcmWavFile(outputPath, clip);
          yield* Effect.sleep(`${config.gapMs} millis`);
        }

        return {
          positiveClips,
          negativeClips,
        };
      }).pipe(Effect.ensuring(client.disconnect));

      const model = yield* trainLinearWakewordModel(featureSessions, {
        positiveClips,
        negativeClips,
      });

      yield* saveTrainedWakewordModel(plan.outputModelPath, model);

      let manifestMessage = "Manifest unchanged";
      if (config.register) {
        const added = yield* registerWakewordModelInManifest(
          plan.manifestPath,
          plan.outputModelFileName,
        );
        manifestMessage = added
          ? `Registered ${plan.outputModelFileName} in ${plan.manifestPath}`
          : `${plan.outputModelFileName} already present in ${plan.manifestPath}`;
      }

      yield* Console.log(`Training complete for '${plan.modelName}'`);
      yield* Console.log(`Positive clips saved in: ${plan.positiveDir}`);
      yield* Console.log(`Negative clips saved in: ${plan.negativeDir}`);
      yield* Console.log(`Model saved to: ${plan.outputModelPath}`);
      yield* Console.log(
        `Training metrics: positive_mean=${model.metrics.positiveMean.toFixed(3)} negative_mean=${model.metrics.negativeMean.toFixed(3)}`,
      );
      yield* Console.log(manifestMessage);
      yield* Console.log(
        `Verify with: npm run cli -- wakeword --models ${plan.outputModelFileName} --duration 20 --threshold 0.5`,
      );
    }),
).pipe(
  Command.withDescription(
    "Collect positive/negative clips, train a wakeword model, save it, and optionally register in manifest",
  ),
);

const rootCommand = Command.make("pie", {}, () => runAssistantDefaultCommand).pipe(
  Command.withDescription("pie command line (no args runs combined wakeword + PTT assistant mode)"),
  Command.withSubcommands([
    recordCommand,
    sourcesCommand,
    meterCommand,
    pttPortalCommand,
    pttCommand,
    pttTranscribeCommand,
    pttTranslateCommand,
    sttInteractiveCommand,
    typeCommand,
    wakewordCommand,
    wakewordTuneCommand,
    wakewordTrainCommand,
  ]),
);

const runtimeLayer = Layer.merge(NodeServices.layer, pulseLayer());

const main = Command.run(rootCommand, { version: "0.1.0" }).pipe(Effect.provide(runtimeLayer));

NodeRuntime.runMain(main);
