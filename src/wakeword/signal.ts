export const flattenMatrix = (rows: ReadonlyArray<Float32Array>): Float32Array => {
  if (rows.length === 0) {
    return new Float32Array()
  }

  const width = rows[0]?.length ?? 0
  const out = new Float32Array(rows.length * width)

  let offset = 0
  for (const row of rows) {
    out.set(row, offset)
    offset += row.length
  }

  return out
}

export const toFrameMatrix = (data: Float32Array, featureCount: number): Array<Float32Array> => {
  if (featureCount <= 0) {
    return []
  }

  const frameCount = Math.floor(data.length / featureCount)
  const frames: Array<Float32Array> = []

  for (let frame = 0; frame < frameCount; frame += 1) {
    const start = frame * featureCount
    frames.push(data.slice(start, start + featureCount))
  }

  return frames
}

export const transformMelspectrogram = (data: Float32Array): Float32Array => {
  const transformed = new Float32Array(data.length)
  for (let index = 0; index < data.length; index += 1) {
    transformed[index] = (data[index] ?? 0) / 10 + 2
  }
  return transformed
}
