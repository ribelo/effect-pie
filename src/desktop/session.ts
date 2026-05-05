import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"

export type DesktopSessionType = "wayland" | "x11" | "unknown"

export class SessionDetectionError extends Data.TaggedError("SessionDetectionError")<{
  readonly message: string
}> {}

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

export class DesktopSession extends Context.Service<
  DesktopSession,
  {
    readonly detect: Effect.Effect<DesktopSessionType, SessionDetectionError>
  }
>()("pie/desktop/DesktopSession") {
  static readonly live = Layer.effect(DesktopSession)(
    Effect.gen(function* () {
      return DesktopSession.of({
        detect: Effect.sync(() => detectDesktopSessionType()).pipe(
          Effect.flatMap((sessionType) =>
            sessionType === "unknown"
              ? Effect.fail(
                  new SessionDetectionError({
                    message:
                      "Could not detect graphical session. Set XDG_SESSION_TYPE or ensure WAYLAND_DISPLAY/DISPLAY is available.",
                  }),
                )
              : Effect.succeed(sessionType),
          ),
        ),
      })
    }),
  )
}
