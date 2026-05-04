export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

export const buildPcmWavHeader = (dataLength: number, sampleRate: number): Uint8Array => {
  const header = new ArrayBuffer(44)
  const view = new DataView(header)

  const writeString = (offset: number, value: string): void => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index))
    }
  }

  writeString(0, "RIFF")
  view.setUint32(4, 36 + dataLength, true)
  writeString(8, "WAVE")
  writeString(12, "fmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeString(36, "data")
  view.setUint32(40, dataLength, true)

  return new Uint8Array(header)
}
