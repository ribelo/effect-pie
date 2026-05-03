export const PTT_POST_ROLL_MS = 2000

export type PttCaptureState =
  | { readonly tag: "idle"; readonly startedAt: undefined; readonly releaseAt: undefined }
  | { readonly tag: "capturing"; readonly startedAt: number; readonly releaseAt: undefined }
  | { readonly tag: "postRoll"; readonly startedAt: number; readonly releaseAt: number }

export const pttCaptureIdle: PttCaptureState = {
  tag: "idle",
  startedAt: undefined,
  releaseAt: undefined,
}

export const pttCaptureStart = (state: PttCaptureState, now: number): PttCaptureState => {
  if (state.tag === "capturing") {
    return state
  }

  if (state.tag === "postRoll") {
    return {
      tag: "capturing",
      startedAt: state.startedAt,
      releaseAt: undefined,
    }
  }

  return {
    tag: "capturing",
    startedAt: now,
    releaseAt: undefined,
  }
}

export const pttCaptureRelease = (state: PttCaptureState, now: number): PttCaptureState => {
  if (state.tag !== "capturing") {
    return state
  }

  return {
    tag: "postRoll",
    startedAt: state.startedAt,
    releaseAt: now,
  }
}

export const pttCaptureIsAcceptingChunks = (state: PttCaptureState): boolean => {
  return state.tag === "capturing" || state.tag === "postRoll"
}

export const pttCapturePostRollRemainingMs = (state: PttCaptureState, now: number): number => {
  if (state.tag !== "postRoll") {
    return 0
  }

  return Math.max(0, state.releaseAt + PTT_POST_ROLL_MS - now)
}

export const pttCaptureDurationMs = (state: PttCaptureState, now: number): number => {
  if (state.startedAt === undefined) {
    return 0
  }

  return now - state.startedAt
}
