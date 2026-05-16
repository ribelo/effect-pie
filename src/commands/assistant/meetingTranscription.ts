import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Queue from "effect/Queue"
import * as Ref from "effect/Ref"
import * as Stream from "effect/Stream"
import type { Cause } from "effect"
import * as fs from "node:fs/promises"
import * as path from "node:path"

import { makePcmRecordOptions, type SourceInfo } from "../../pulse/defs.js"
import { PulseAudioClient } from "../../pulse/client.js"
import { EFFECT_PI_DATA_DIR } from "../../paths.js"
import { SttService } from "../../stt/service.js"
import type { SttRuntimeConfig } from "../../stt/config.js"
import { RecordingCoordinator, type RecordingSnapshot, type StartResult } from "./coordinator.js"

const MEETING_SAMPLE_RATE = 24_000
const MEETING_FRAGMENT_SIZE = 4_800

export const MEETING_TRANSCRIPT_DIR = path.join(EFFECT_PI_DATA_DIR, "meetings")

type ActiveMeeting = {
  readonly audioQueue: Queue.Queue<Uint8Array, Cause.Done>
  readonly captureFiber: Fiber.Fiber<void, unknown>
  readonly sttFiber: Fiber.Fiber<void, unknown>
  readonly transcriptPath: string
}

export const resolveMeetingMonitorSource = (config: {
  readonly defaultSink: string | null
  readonly sources: ReadonlyArray<SourceInfo>
}): SourceInfo => {
  const monitorSources = config.sources.filter((source) => {
    const name = source.name?.toLowerCase() ?? ""
    const description = source.description?.toLowerCase() ?? ""
    return name.includes(".monitor") || description.startsWith("monitor of")
  })

  if (monitorSources.length === 0) {
    throw new Error(
      "No PulseAudio monitor source found. Run 'pie sources' and verify output audio exists.",
    )
  }

  const defaultSink = config.defaultSink
  if (defaultSink !== null && defaultSink.length > 0) {
    const byMonitorName = monitorSources.find((source) => source.monitorName === defaultSink)
    if (byMonitorName !== undefined) return byMonitorName

    const byName = monitorSources.find((source) => source.name === `${defaultSink}.monitor`)
    if (byName !== undefined) return byName
  }

  return monitorSources[0]!
}

const makeMeetingTranscriptPath = (now: Date, transcriptDir: string): string => {
  const stamp = now
    .toISOString()
    .replaceAll(":", "-")
    .replace(/\.\d{3}Z$/, "Z")
  return path.join(transcriptDir, `meeting-${stamp}.txt`)
}

const appendTranscript = (transcriptPath: string, text: string) =>
  Effect.promise(() => fs.appendFile(transcriptPath, text, "utf8"))

export class MeetingTranscriptionController extends Context.Service<
  MeetingTranscriptionController,
  {
    readonly start: Effect.Effect<{
      readonly result: StartResult
      readonly snapshot: RecordingSnapshot
    }>
    readonly stop: Effect.Effect<RecordingSnapshot>
    readonly toggle: Effect.Effect<RecordingSnapshot>
  }
>()("pie/commands/assistant/MeetingTranscriptionController") {
  static readonly live = (options: {
    readonly sttConfig: SttRuntimeConfig
    readonly transcriptDir?: string | undefined
  }): Layer.Layer<
    MeetingTranscriptionController,
    never,
    PulseAudioClient | SttService | RecordingCoordinator
  > =>
    Layer.effect(
      MeetingTranscriptionController,
      Effect.gen(function* () {
        const coordinator = yield* RecordingCoordinator
        const pulse = yield* PulseAudioClient
        const stt = yield* SttService
        const layerScope = yield* Effect.scope
        const activeRef = yield* Ref.make<ActiveMeeting | undefined>(undefined)
        const transcriptDir = options.transcriptDir ?? MEETING_TRANSCRIPT_DIR

        const stopActive = Effect.gen(function* () {
          const active = yield* Ref.get(activeRef)
          yield* Ref.set(activeRef, undefined)
          if (active === undefined) return undefined

          yield* Queue.end(active.audioQueue).pipe(Effect.ignore)
          yield* Fiber.interrupt(active.captureFiber).pipe(Effect.ignore)
          yield* Fiber.join(active.sttFiber).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Meeting transcription stopped with STT error").pipe(
                Effect.annotateLogs({
                  "meeting.transcript_path": active.transcriptPath,
                  cause,
                }),
              ),
            ),
            Effect.ignore,
          )
          return active.transcriptPath
        })

        const stop = Effect.gen(function* () {
          const transcriptPath = yield* stopActive
          yield* coordinator.stop("meeting-transcribe")
          const snapshot = yield* coordinator.snapshot
          yield* Effect.logInfo("Meeting transcription stopped").pipe(
            Effect.annotateLogs({ "meeting.transcript_path": transcriptPath ?? "" }),
          )
          return snapshot
        })

        const startUnsafe = Effect.gen(function* () {
          const existing = yield* Ref.get(activeRef)
          if (existing !== undefined) {
            const snapshot = yield* coordinator.snapshot
            return {
              result: { _tag: "Busy" as const, activeMode: "meeting-transcribe" as const },
              snapshot,
            }
          }

          const serverInfo = yield* pulse.getServerInfo
          const sources = yield* pulse.listSources
          const monitorSource = resolveMeetingMonitorSource({
            defaultSink: serverInfo.defaultSink,
            sources,
          })

          if (monitorSource.name === null) {
            return yield* Effect.fail(new Error("Selected PulseAudio monitor source has no name"))
          }

          const transcriptPath = makeMeetingTranscriptPath(new Date(), transcriptDir)
          yield* Effect.promise(() => fs.mkdir(path.dirname(transcriptPath), { recursive: true }))
          yield* Effect.promise(() => fs.writeFile(transcriptPath, "", "utf8"))

          const result = yield* coordinator.tryStart("meeting-transcribe", { transcriptPath })
          const snapshot = yield* coordinator.snapshot
          if (Reflect.get(result, "_tag") !== "Started") {
            return { result, snapshot }
          }

          const audioQueue = yield* Queue.unbounded<Uint8Array, Cause.Done>()
          const streamedCharsRef = yield* Ref.make(0)

          const recordOptions = makePcmRecordOptions({
            channels: 1,
            rate: MEETING_SAMPLE_RATE,
            fragmentSize: MEETING_FRAGMENT_SIZE,
            sourceName: monitorSource.name,
          })

          const captureFiber = yield* Effect.gen(function* () {
            yield* Effect.scoped(
              Effect.gen(function* () {
                const opened = yield* pulse.acquireRecordStream(recordOptions)
                yield* Stream.fromQueue(opened.queue).pipe(
                  Stream.runForEach((chunk) => Queue.offer(audioQueue, chunk)),
                  Effect.ensuring(Queue.end(audioQueue)),
                )
              }),
            )
          }).pipe(Effect.forkIn(layerScope))

          const sttFiber = yield* stt
            .transcribeStream({
              model: options.sttConfig.transcriptionModel,
              audio: Stream.fromQueue(audioQueue),
              sampleRate: MEETING_SAMPLE_RATE,
              language: options.sttConfig.transcriptionLanguage,
              promptTemplate: options.sttConfig.transcriptionPrompt,
              onDelta: (delta) =>
                appendTranscript(transcriptPath, delta).pipe(
                  Effect.andThen(Ref.update(streamedCharsRef, (current) => current + delta.length)),
                ),
            })
            .pipe(
              Effect.flatMap((text) =>
                Effect.gen(function* () {
                  const streamedChars = yield* Ref.get(streamedCharsRef)
                  if (streamedChars === 0 && text.length > 0) {
                    yield* appendTranscript(transcriptPath, text)
                  }
                }),
              ),
              Effect.tapError((cause) =>
                Effect.gen(function* () {
                  yield* stopActive
                  yield* coordinator.stop("meeting-transcribe")
                  yield* coordinator.setError(cause.message)
                  yield* Effect.logError("Meeting transcription failed").pipe(
                    Effect.annotateLogs({
                      "meeting.source": monitorSource.name,
                      "meeting.transcript_path": transcriptPath,
                      cause,
                    }),
                  )
                }),
              ),
              Effect.asVoid,
              Effect.forkIn(layerScope),
            )

          yield* Ref.set(activeRef, { audioQueue, captureFiber, sttFiber, transcriptPath })
          yield* Effect.logInfo("Meeting transcription started").pipe(
            Effect.annotateLogs({
              "meeting.source": monitorSource.name,
              "meeting.transcript_path": transcriptPath,
              "stt.model": options.sttConfig.transcriptionModel,
            }),
          )

          return { result, snapshot }
        })

        const start = startUnsafe.pipe(
          Effect.catch((cause) =>
            Effect.gen(function* () {
              yield* stopActive
              yield* coordinator.stop("meeting-transcribe")
              yield* coordinator.setError(cause.message)
              yield* Effect.logError("Meeting transcription failed to start").pipe(
                Effect.annotateLogs({ cause }),
              )
              const snapshot = yield* coordinator.snapshot
              return { result: { _tag: "Disabled" as const }, snapshot }
            }),
          ),
        )

        const toggle = Effect.gen(function* () {
          const snapshot = yield* coordinator.snapshot
          if (snapshot.mode === "meeting-transcribe") {
            return yield* stop
          }
          const started = yield* start
          return started.snapshot
        })

        return MeetingTranscriptionController.of({ start, stop, toggle })
      }),
    )
}
