#!/usr/bin/env node
const { execSync } = require("child_process")
const path = require("path")

const platform = process.platform
const arch = process.arch
const binaryName = platform === "win32" ? "tsgo.exe" : "tsgo"
const packageName = `@effect/tsgo-${platform}-${arch}`

let binaryPath
try {
  const pkgPath = require.resolve(`${packageName}/package.json`)
  binaryPath = path.join(path.dirname(pkgPath), "lib", binaryName)
} catch {
  console.error(`Platform-specific tsgo binary not found: ${packageName}`)
  process.exit(1)
}

const args = process.argv.slice(2).join(" ")
let output = ""
try {
  output = execSync(`"${binaryPath}" ${args}`, {
    encoding: "utf8",
    stdio: ["inherit", "pipe", "pipe"],
  })
  process.stdout.write(output)
  process.exit(0)
} catch (error) {
  if (error.stdout) process.stdout.write(error.stdout)
  if (error.stderr) process.stderr.write(error.stderr)
  if (error.status !== undefined) {
    const combinedOutput = (error.stdout || "") + (error.stderr || "")
    const hasErrors = /error TS\d+/.test(combinedOutput)
    if (!hasErrors && error.status === 2) {
      process.exit(0)
    }
    process.exit(error.status)
  }
  throw error
}
