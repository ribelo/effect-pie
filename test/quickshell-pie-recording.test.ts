import { test } from "node:test"
import * as assert from "node:assert/strict"
import * as fs from "node:fs/promises"

const pieRecordingQmlPath =
  "/home/ribelo/.dotfiles/nixos/home/common/desktop/quickshell/widgets/PieRecording.qml"

test("PieRecording renders meeting transcription as blinking red", async () => {
  const qml = await fs.readFile(pieRecordingQmlPath, "utf8")

  assert.match(qml, /state\.mode === "meeting-transcribe"/)
  assert.match(qml, /root\.visualState === "meeting-transcribe"[^\n]*Theme\.stateError/s)
  assert.match(qml, /root\.visualState === "meeting-transcribe"[^\n]*meetingBlinkOn/s)
})

test("PieRecording popup exposes meeting transcription toggle", async () => {
  const qml = await fs.readFile(pieRecordingQmlPath, "utf8")

  assert.match(
    qml,
    /text: root\.visualState === "meeting-transcribe" \? "Stop meeting transcribe" : "Start meeting transcribe"/,
  )
  assert.match(qml, /id: toggleMeeting/)
  assert.match(qml, /pie meeting-toggle/)
})

test("PieRecording uses current pie CLI controls instead of stale HTTP curl", async () => {
  const qml = await fs.readFile(pieRecordingQmlPath, "utf8")

  assert.doesNotMatch(qml, /curl/)
  assert.doesNotMatch(qml, /http:\/\/localhost\/toggle/)
  assert.match(qml, /pie toggle/)
})
