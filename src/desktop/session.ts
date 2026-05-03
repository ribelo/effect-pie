export type DesktopSessionType = "wayland" | "x11" | "unknown"

const readEnv = (env: NodeJS.ProcessEnv, key: string): string | undefined => {
  const value = env[key]?.trim()
  return value === undefined || value.length === 0 ? undefined : value
}

export const detectDesktopSessionType = (
  env: NodeJS.ProcessEnv = process.env,
): DesktopSessionType => {
  const xdgSessionType = readEnv(env, "XDG_SESSION_TYPE")?.toLowerCase()

  if (xdgSessionType === "wayland") {
    return "wayland"
  }

  if (xdgSessionType === "x11") {
    return "x11"
  }

  if (readEnv(env, "WAYLAND_DISPLAY") !== undefined) {
    return "wayland"
  }

  if (readEnv(env, "DISPLAY") !== undefined) {
    return "x11"
  }

  return "unknown"
}
