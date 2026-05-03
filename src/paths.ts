import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const APP_DIR_NAME = "pie"
const LEGACY_APP_DIR_NAME = "effect-pi"

const resolveXdgHome = (envKey: "XDG_DATA_HOME" | "XDG_CONFIG_HOME", fallback: string): string => {
  const value = process.env[envKey]?.trim()
  if (value !== undefined && value.length > 0) {
    return path.resolve(value)
  }

  return path.join(os.homedir(), fallback)
}

const resolveAppSubdir = (baseDir: string): string => {
  const preferred = path.join(baseDir, APP_DIR_NAME)
  const legacy = path.join(baseDir, LEGACY_APP_DIR_NAME)

  if (fs.existsSync(legacy)) {
    return legacy
  }

  if (fs.existsSync(preferred)) {
    return preferred
  }

  return preferred
}

export const XDG_DATA_HOME = resolveXdgHome("XDG_DATA_HOME", ".local/share")
export const XDG_CONFIG_HOME = resolveXdgHome("XDG_CONFIG_HOME", ".config")

const resolveXdgRuntimeDir = (): string => {
  const runtimeDir = process.env["XDG_RUNTIME_DIR"]?.trim()
  if (runtimeDir !== undefined && runtimeDir.length > 0) {
    return path.resolve(runtimeDir)
  }

  const uid = typeof process.getuid === "function" ? process.getuid() : undefined
  return uid === undefined ? path.join(os.tmpdir(), "pie-runtime") : `/run/user/${uid}`
}

export const XDG_RUNTIME_DIR = resolveXdgRuntimeDir()

export const EFFECT_PI_DATA_DIR = resolveAppSubdir(XDG_DATA_HOME)
export const EFFECT_PI_CONFIG_DIR = resolveAppSubdir(XDG_CONFIG_HOME)
export const EFFECT_PI_RUNTIME_DIR = path.join(XDG_RUNTIME_DIR, APP_DIR_NAME)

export const EFFECT_PI_OPENWAKEWORD_DATA_DIR = path.join(EFFECT_PI_DATA_DIR, "openwakeword")
export const EFFECT_PI_WAKEWORD_CONFIG_DIR = path.join(EFFECT_PI_CONFIG_DIR, "wakeword")

export const BUNDLED_OPENWAKEWORD_ASSET_DIR = path.join(process.cwd(), "assets", "openwakeword")
