import { test } from "node:test"
import * as assert from "node:assert/strict"
import { mkdtemp, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import * as path from "node:path"

test("resolveAppSubdir uses pie path when legacy effect-pi directory exists", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "pie-paths-"))
  const legacyDir = path.join(tempDir, "effect-pi")
  const pieDir = path.join(tempDir, "pie")
  await mkdir(legacyDir, { recursive: true })

  const originalXdgDataHome = process.env["XDG_DATA_HOME"]
  const originalXdgConfigHome = process.env["XDG_CONFIG_HOME"]

  try {
    process.env["XDG_DATA_HOME"] = tempDir
    process.env["XDG_CONFIG_HOME"] = tempDir

    const { EFFECT_PI_DATA_DIR, EFFECT_PI_CONFIG_DIR } = await import(
      `../src/paths.js?${Date.now()}`
    )

    assert.strictEqual(EFFECT_PI_DATA_DIR, pieDir)
    assert.strictEqual(EFFECT_PI_CONFIG_DIR, pieDir)
  } finally {
    if (originalXdgDataHome !== undefined) {
      process.env["XDG_DATA_HOME"] = originalXdgDataHome
    } else {
      delete process.env["XDG_DATA_HOME"]
    }
    if (originalXdgConfigHome !== undefined) {
      process.env["XDG_CONFIG_HOME"] = originalXdgConfigHome
    } else {
      delete process.env["XDG_CONFIG_HOME"]
    }
  }
})
