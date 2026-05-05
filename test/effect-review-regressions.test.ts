import { test } from "node:test"
import * as assert from "node:assert/strict"
import { promises as fs } from "node:fs"

test("src/index.ts is export-only and has no runtime side effect", async () => {
  const source = await fs.readFile("src/index.ts", "utf8")

  assert.match(source, /export \{ rootCommand \} from "\.\/cli\.js"/)
  assert.doesNotMatch(source, /BunRuntime\.runMain/)
  assert.doesNotMatch(source, /Effect\.log\("pie"\)/)
})

test("wakeword live finalizer does not use orElseSucceed to swallow shutdown errors", async () => {
  const source = await fs.readFile("src/wakeword/live.ts", "utf8")

  assert.doesNotMatch(source, /orElseSucceed/)
})

test("global shortcut signal monitor uses the shared subprocess abstraction", async () => {
  const source = await fs.readFile("src/wayland/globalShortcuts.ts", "utf8")

  assert.match(source, /runLongRunningExternalTool/)
  assert.doesNotMatch(source, /Bun\.spawn\(/)
})

test("executable lookup uses the shared findExecutable utility", async () => {
  const subprocess = await fs.readFile("src/utils/subprocess.ts", "utf8")
  const wtype = await fs.readFile("src/wayland/wtype.ts", "utf8")
  const xdotool = await fs.readFile("src/x11/xdotool.ts", "utf8")
  const globalShortcuts = await fs.readFile("src/wayland/globalShortcuts.ts", "utf8")

  assert.match(subprocess, /export const findExecutable/)
  assert.match(wtype, /findExecutable/)
  assert.match(xdotool, /findExecutable/)
  assert.match(globalShortcuts, /findExecutable/)
})
