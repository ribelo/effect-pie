import { test } from "node:test"
import * as assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"

// We need to test copyFileIfExists directly; import from source
import { copyFileIfExists } from "../src/wakeword/assets.ts"

test("copyFileIfExists returns silently for missing file (ENOENT)", async () => {
  const nonExistent = path.join(os.tmpdir(), `pie-test-enoent-${Date.now()}`)
  const target = path.join(os.tmpdir(), `pie-test-target-${Date.now()}`)

  await copyFileIfExists(nonExistent, target)
  assert.ok(!fs.existsSync(target), "target should not be created for missing source")
})

test("copyFileIfExists throws on non-ENOENT stat errors", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pie-test-enotdir-"))
  const blockingFile = path.join(tmpDir, "blocking")
  fs.writeFileSync(blockingFile, "")

  const badSource = path.join(blockingFile, "inside")
  const target = path.join(os.tmpdir(), `pie-test-target-${Date.now()}`)

  try {
    await copyFileIfExists(badSource, target)
    assert.fail("copyFileIfExists did not throw")
  } catch (error) {
    assert.ok(error instanceof Error, "should throw an Error")
    const code = (error as { code?: string }).code
    assert.ok(
      (error as Error).message.includes("ENOTDIR") || code === "ENOTDIR",
      `expected ENOTDIR, got: ${(error as Error).message}`,
    )
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})
