import * as Rpc from "effect/unstable/rpc/Rpc"
import * as RpcGroup from "effect/unstable/rpc/RpcGroup"
import * as Schema from "effect/Schema"

import {
  RecordingSnapshotSchema,
  StartResultSchema,
} from "../commands/assistant/coordinator.js"

const Status = Rpc.make("Status", { success: RecordingSnapshotSchema })

const Pause = Rpc.make("Pause", { success: Schema.Void })

const Resume = Rpc.make("Resume", { success: Schema.Void })

const Toggle = Rpc.make("Toggle", { success: Schema.Boolean })

const MeetingStart = Rpc.make("MeetingStart", {
  success: Schema.Struct({
    result: StartResultSchema,
    snapshot: RecordingSnapshotSchema,
  }),
})

const MeetingStop = Rpc.make("MeetingStop", {
  success: RecordingSnapshotSchema,
})

const MeetingToggle = Rpc.make("MeetingToggle", {
  success: RecordingSnapshotSchema,
})

export const DaemonRpc = RpcGroup.make(
  Status,
  Pause,
  Resume,
  Toggle,
  MeetingStart,
  MeetingStop,
  MeetingToggle,
)
