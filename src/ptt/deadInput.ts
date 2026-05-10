export const PTT_DEAD_INPUT_WARNING_ZERO_CHUNKS = 4

export type PttDeadInputDetector = {
  active: boolean
  consecutiveZeroChunks: number
  warnedThisHold: boolean
  deadThisHold: boolean
}

export const pttDeadInputDetectorInitial = (): PttDeadInputDetector => ({
  active: false,
  consecutiveZeroChunks: 0,
  warnedThisHold: false,
  deadThisHold: false,
})

export const pttDeadInputDetectorSync = (
  detector: PttDeadInputDetector,
  isActive: boolean,
): PttDeadInputDetector => {
  if (!isActive) {
    return pttDeadInputDetectorInitial()
  }

  if (!detector.active) {
    return {
      active: true,
      consecutiveZeroChunks: 0,
      warnedThisHold: false,
      deadThisHold: false,
    }
  }

  return {
    ...detector,
    active: true,
  }
}

const isFlatlinePcmS16le = (pcm: Uint8Array): boolean =>
  pcm.length > 0 && pcm.every((byte) => byte === 0)

export const pttDeadInputDetectorProcessChunk = (
  detector: PttDeadInputDetector,
  chunk: Uint8Array,
): {
  readonly detector: PttDeadInputDetector
  readonly warn: boolean
  readonly dead: boolean
  readonly hasInput: boolean
} => {
  if (!detector.active) {
    return { detector, warn: false, dead: false, hasInput: false }
  }

  if (detector.deadThisHold) {
    return { detector, warn: false, dead: true, hasInput: false }
  }

  const isFlatline = isFlatlinePcmS16le(chunk)
  const hasInput = chunk.length > 0 && !isFlatline

  const nextConsecutive = isFlatline ? detector.consecutiveZeroChunks + 1 : 0

  if (nextConsecutive < PTT_DEAD_INPUT_WARNING_ZERO_CHUNKS) {
    return {
      detector: {
        ...detector,
        consecutiveZeroChunks: nextConsecutive,
      },
      warn: false,
      dead: false,
      hasInput,
    }
  }

  return {
    detector: {
      ...detector,
      consecutiveZeroChunks: nextConsecutive,
      warnedThisHold: true,
      deadThisHold: true,
    },
    warn: true,
    dead: true,
    hasInput: false,
  }
}

export const pttDeadInputDetectorUpdateAndCheck = (
  detector: PttDeadInputDetector,
  chunk: Uint8Array,
): {
  readonly detector: PttDeadInputDetector
  readonly warn: boolean
  readonly dead: boolean
  readonly hasInput: boolean
} => pttDeadInputDetectorProcessChunk(detector, chunk)
