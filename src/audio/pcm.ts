export const DEFAULT_AUTO_GAIN_TARGET_RMS = 0.12
export const DEFAULT_AUTO_GAIN_MAX = 40.0
export const DEFAULT_AUTO_GAIN_PEAK_LIMIT = 0.95
export const MIN_GAIN_TO_APPLY = 1.05

export const PTT_MIN_CAPTURE_RMS_FOR_STT = 0.003
export const PTT_MIN_CAPTURE_PEAK_FOR_STT = 0.02

export const pcmRms = (chunk: Uint8Array): number => {
  const sampleCount = Math.floor(chunk.length / 2)
  if (sampleCount <= 0) {
    return 0
  }

  const view = new DataView(chunk.buffer, chunk.byteOffset, sampleCount * 2)
  let sumSquares = 0

  for (let index = 0; index < sampleCount; index += 1) {
    const sample = view.getInt16(index * 2, true) / 32768
    sumSquares += sample * sample
  }

  return Math.sqrt(sumSquares / sampleCount)
}

export const pcmPeak = (chunk: Uint8Array): number => {
  const sampleCount = Math.floor(chunk.length / 2)
  if (sampleCount <= 0) {
    return 0
  }

  const view = new DataView(chunk.buffer, chunk.byteOffset, sampleCount * 2)
  let peak = 0

  for (let index = 0; index < sampleCount; index += 1) {
    const normalized = Math.abs(view.getInt16(index * 2, true) / 32768)
    if (normalized > peak) {
      peak = normalized
    }
  }

  return peak
}

export const computeNormalizationGain = (config: {
  readonly pcmBytes: Uint8Array
  readonly targetRms: number
  readonly maxGain: number
  readonly peakLimit: number
  readonly silenceRmsThreshold: number
  readonly silencePeakThreshold: number
}): number => {
  const rms = pcmRms(config.pcmBytes)
  const peak = pcmPeak(config.pcmBytes)

  if (rms <= 0 || peak <= 0) {
    return 1.0
  }

  if (rms < config.silenceRmsThreshold && peak < config.silencePeakThreshold) {
    return 1.0
  }

  const targetGain = Math.min(config.maxGain, Math.max(1.0, config.targetRms / rms))
  const peakLimitedGain = Math.min(config.maxGain, Math.max(1.0, config.peakLimit / peak))

  return Math.min(targetGain, peakLimitedGain)
}

export const normalizePcmS16leTargetRms = (config: {
  readonly pcmBytes: Uint8Array
  readonly targetRms: number
  readonly maxGain: number
  readonly peakLimit: number
  readonly silenceRmsThreshold: number
  readonly silencePeakThreshold: number
}): { readonly normalizedBytes: Uint8Array; readonly gain: number } => {
  const gain = computeNormalizationGain(config)

  if (gain <= MIN_GAIN_TO_APPLY) {
    return { normalizedBytes: config.pcmBytes, gain }
  }

  const normalizedBytes = new Uint8Array(config.pcmBytes.length)
  const view = new DataView(
    config.pcmBytes.buffer,
    config.pcmBytes.byteOffset,
    config.pcmBytes.length,
  )
  const outView = new DataView(normalizedBytes.buffer)

  for (let index = 0; index < config.pcmBytes.length - 1; index += 2) {
    const sample = view.getInt16(index, true)
    const boosted = Math.max(-32768, Math.min(32767, Math.round(sample * gain)))
    outView.setInt16(index, boosted, true)
  }

  if (config.pcmBytes.length % 2 !== 0) {
    normalizedBytes[config.pcmBytes.length - 1] = config.pcmBytes[config.pcmBytes.length - 1]!
  }

  return { normalizedBytes, gain }
}

export const normalizePcmForStt = (
  pcmBytes: Uint8Array,
): { readonly normalizedBytes: Uint8Array; readonly gain: number } =>
  normalizePcmS16leTargetRms({
    pcmBytes,
    targetRms: DEFAULT_AUTO_GAIN_TARGET_RMS,
    maxGain: DEFAULT_AUTO_GAIN_MAX,
    peakLimit: DEFAULT_AUTO_GAIN_PEAK_LIMIT,
    silenceRmsThreshold: PTT_MIN_CAPTURE_RMS_FOR_STT,
    silencePeakThreshold: PTT_MIN_CAPTURE_PEAK_FOR_STT,
  })
