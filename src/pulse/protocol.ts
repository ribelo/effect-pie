import {
  PA_MAX_CHANNELS,
  PA_NO_INDEX,
  PA_SAMPLE_FORMAT,
  PA_STREAM_DESCRIPTOR,
  PA_STREAM_DESCRIPTOR_SIZE,
  PA_TAG,
  type ChannelMap,
  type SampleSpec,
} from "./defs.js"

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const isSampleFormat = (value: number): value is PA_SAMPLE_FORMAT =>
  Object.values(PA_SAMPLE_FORMAT).some((candidate) => candidate === value)

export type PacketHeader = {
  readonly length: number
  readonly channel: number
  readonly offsetHi: number
  readonly offsetLo: number
  readonly flags: number
}

const checkedLength = (length: number) => {
  if (!Number.isInteger(length) || length < 0 || length > 0xffffffff) {
    throw new Error(`invalid packet length: ${length}`)
  }
  return length
}

export const concatBytes = (chunks: ReadonlyArray<Uint8Array>): Uint8Array => {
  const size = chunks.reduce((total, chunk) => total + chunk.length, 0)
  const out = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

export const encodePacketHeader = ({
  length,
  channel,
  offsetHi,
  offsetLo,
  flags,
}: PacketHeader): Uint8Array => {
  const header = new Uint8Array(PA_STREAM_DESCRIPTOR_SIZE)
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength)

  view.setUint32(PA_STREAM_DESCRIPTOR.LENGTH * 4, checkedLength(length), false)
  view.setUint32(PA_STREAM_DESCRIPTOR.CHANNEL * 4, channel >>> 0, false)
  view.setUint32(PA_STREAM_DESCRIPTOR.OFFSET_HI * 4, offsetHi >>> 0, false)
  view.setUint32(PA_STREAM_DESCRIPTOR.OFFSET_LO * 4, offsetLo >>> 0, false)
  view.setUint32(PA_STREAM_DESCRIPTOR.FLAGS * 4, flags >>> 0, false)

  return header
}

export const decodePacketHeader = (header: Uint8Array): PacketHeader => {
  if (header.length !== PA_STREAM_DESCRIPTOR_SIZE) {
    throw new Error(`invalid packet header size: ${header.length}`)
  }

  const view = new DataView(header.buffer, header.byteOffset, header.byteLength)

  return {
    length: view.getUint32(PA_STREAM_DESCRIPTOR.LENGTH * 4, false),
    channel: view.getUint32(PA_STREAM_DESCRIPTOR.CHANNEL * 4, false),
    offsetHi: view.getUint32(PA_STREAM_DESCRIPTOR.OFFSET_HI * 4, false),
    offsetLo: view.getUint32(PA_STREAM_DESCRIPTOR.OFFSET_LO * 4, false),
    flags: view.getUint32(PA_STREAM_DESCRIPTOR.FLAGS * 4, false),
  }
}

export const framePacket = (payload: Uint8Array, channel = PA_NO_INDEX, flags = 0): Uint8Array =>
  concatBytes([
    encodePacketHeader({
      length: payload.length,
      channel,
      offsetHi: 0,
      offsetLo: 0,
      flags,
    }),
    payload,
  ])

export const splitFramedPacket = (
  packet: Uint8Array,
): { readonly header: PacketHeader; readonly payload: Uint8Array } => {
  if (packet.length < PA_STREAM_DESCRIPTOR_SIZE) {
    throw new Error("packet shorter than descriptor")
  }

  const headerBytes = packet.slice(0, PA_STREAM_DESCRIPTOR_SIZE)
  const header = decodePacketHeader(headerBytes)
  const payload = packet.slice(PA_STREAM_DESCRIPTOR_SIZE)

  if (payload.length !== header.length) {
    throw new Error(`packet payload mismatch: expected ${header.length}, got ${payload.length}`)
  }

  return { header, payload }
}

export class TagStructWriter {
  private buffer: Uint8Array
  private view: DataView
  private offset = 0

  constructor(initialCapacity = 64) {
    this.buffer = new Uint8Array(initialCapacity)
    this.view = new DataView(this.buffer.buffer, this.buffer.byteOffset, this.buffer.byteLength)
  }

  private ensure(extraBytes: number): void {
    const required = this.offset + extraBytes
    if (required <= this.buffer.length) {
      return
    }

    let nextSize = this.buffer.length
    while (nextSize < required) {
      nextSize *= 2
    }

    const next = new Uint8Array(nextSize)
    next.set(this.buffer.subarray(0, this.offset))
    this.buffer = next
    this.view = new DataView(this.buffer.buffer, this.buffer.byteOffset, this.buffer.byteLength)
  }

  private writeTag(tag: PA_TAG): void {
    this.ensure(1)
    this.buffer[this.offset] = tag
    this.offset += 1
  }

  addUInt8(value: number): this {
    this.writeTag(PA_TAG.U8)
    this.ensure(1)
    this.buffer[this.offset] = value & 0xff
    this.offset += 1
    return this
  }

  addUInt32(value: number): this {
    this.writeTag(PA_TAG.U32)
    this.ensure(4)
    this.view.setUint32(this.offset, value >>> 0, false)
    this.offset += 4
    return this
  }

  addUInt64(value: bigint | number): this {
    this.writeTag(PA_TAG.U64)
    this.ensure(8)
    this.view.setBigUint64(this.offset, BigInt(value), false)
    this.offset += 8
    return this
  }

  addUsec(value: bigint | number): this {
    this.writeTag(PA_TAG.USEC)
    this.ensure(8)
    this.view.setBigUint64(this.offset, BigInt(value), false)
    this.offset += 8
    return this
  }

  addString(value: string | null): this {
    if (value === null) {
      this.writeTag(PA_TAG.STRING_NULL)
      return this
    }

    const encoded = encoder.encode(value)
    this.writeTag(PA_TAG.STRING)
    this.ensure(encoded.length + 1)
    this.buffer.set(encoded, this.offset)
    this.offset += encoded.length
    this.buffer[this.offset] = 0
    this.offset += 1
    return this
  }

  addBool(value: boolean): this {
    this.writeTag(value ? PA_TAG.BOOLEAN_TRUE : PA_TAG.BOOLEAN_FALSE)
    return this
  }

  addArbitrary(value: Uint8Array): this {
    this.writeTag(PA_TAG.ARBITRARY)
    this.ensure(4 + value.length)
    this.view.setUint32(this.offset, value.length, false)
    this.offset += 4
    if (value.length > 0) {
      this.buffer.set(value, this.offset)
      this.offset += value.length
    }
    return this
  }

  addSampleSpec(spec: SampleSpec): this {
    this.writeTag(PA_TAG.SAMPLE_SPEC)
    if (spec.channels < 0 || spec.channels >= PA_MAX_CHANNELS) {
      throw new Error(`invalid channel count: ${spec.channels}`)
    }
    this.ensure(6)
    this.buffer[this.offset] = spec.format
    this.offset += 1
    this.buffer[this.offset] = spec.channels
    this.offset += 1
    this.view.setUint32(this.offset, spec.rate >>> 0, false)
    this.offset += 4
    return this
  }

  addChannelMap(map: ChannelMap): this {
    if (map.length > 255) {
      throw new Error(`channel map too long: ${map.length}`)
    }
    this.writeTag(PA_TAG.CHANNEL_MAP)
    this.ensure(1 + map.length)
    this.buffer[this.offset] = map.length
    this.offset += 1
    for (const channel of map) {
      this.buffer[this.offset] = channel & 0xff
      this.offset += 1
    }
    return this
  }

  addProps(props: Readonly<Record<string, string>>): this {
    this.writeTag(PA_TAG.PROPLIST)
    for (const [key, value] of Object.entries(props)) {
      this.addString(key)
      const encoded = encoder.encode(value)
      const withTerminator = new Uint8Array(encoded.length + 1)
      withTerminator.set(encoded)
      withTerminator[withTerminator.length - 1] = 0
      this.addUInt32(withTerminator.length)
      this.addArbitrary(withTerminator)
    }
    this.addString(null)
    return this
  }

  addCvolume(volumes: ReadonlyArray<number>): this {
    if (volumes.length > 255) {
      throw new Error(`too many channels in cvolume: ${volumes.length}`)
    }
    this.writeTag(PA_TAG.CVOLUME)
    this.ensure(1 + volumes.length * 4)
    this.buffer[this.offset] = volumes.length
    this.offset += 1
    for (const volume of volumes) {
      this.view.setUint32(this.offset, volume >>> 0, false)
      this.offset += 4
    }
    return this
  }

  addVolume(volume: number): this {
    this.writeTag(PA_TAG.VOLUME)
    this.ensure(4)
    this.view.setUint32(this.offset, volume >>> 0, false)
    this.offset += 4
    return this
  }

  addFormatInfo(encoding: number, props: Readonly<Record<string, string>> = {}): this {
    this.writeTag(PA_TAG.FORMAT_INFO)
    this.addUInt8(encoding)
    this.addProps(props)
    return this
  }

  finalize(): Uint8Array {
    return this.buffer.slice(0, this.offset)
  }
}

export class TagStructReader {
  private readonly body: Uint8Array
  private readonly view: DataView
  private offset = 0

  constructor(body: Uint8Array) {
    this.body = body
    this.view = new DataView(body.buffer, body.byteOffset, body.byteLength)
  }

  private assertReadable(bytes: number): void {
    if (this.offset + bytes > this.body.length) {
      throw new Error(`packet too short: need ${bytes} more bytes`)
    }
  }

  private assertTag(expected: PA_TAG): void {
    this.assertReadable(1)
    const tag = this.body[this.offset]!
    if (tag !== expected) {
      throw new Error(`invalid tag: expected ${expected}, got ${tag}`)
    }
    this.offset += 1
  }

  getUInt8(): number {
    this.assertTag(PA_TAG.U8)
    this.assertReadable(1)
    const value = this.body[this.offset]!
    this.offset += 1
    return value
  }

  getUInt32(): number {
    this.assertTag(PA_TAG.U32)
    this.assertReadable(4)
    const value = this.view.getUint32(this.offset, false)
    this.offset += 4
    return value
  }

  getUInt64(): bigint {
    this.assertTag(PA_TAG.U64)
    this.assertReadable(8)
    const value = this.view.getBigUint64(this.offset, false)
    this.offset += 8
    return value
  }

  getSInt64(): bigint {
    this.assertTag(PA_TAG.S64)
    this.assertReadable(8)
    const value = this.view.getBigInt64(this.offset, false)
    this.offset += 8
    return value
  }

  getUsec(): bigint {
    this.assertTag(PA_TAG.USEC)
    this.assertReadable(8)
    const value = this.view.getBigUint64(this.offset, false)
    this.offset += 8
    return value
  }

  getString(): string | null {
    this.assertReadable(1)
    const tag = this.body[this.offset]!

    if (tag === PA_TAG.STRING_NULL) {
      this.offset += 1
      return null
    }

    if (tag !== PA_TAG.STRING) {
      throw new Error(`invalid tag: expected ${PA_TAG.STRING} or ${PA_TAG.STRING_NULL}, got ${tag}`)
    }

    this.offset += 1
    const start = this.offset
    while (this.offset < this.body.length && this.body[this.offset] !== 0) {
      this.offset += 1
    }

    if (this.offset >= this.body.length) {
      throw new Error("unterminated string")
    }

    const value = decoder.decode(this.body.subarray(start, this.offset))
    this.offset += 1
    return value
  }

  getArbitrary(): Uint8Array {
    this.assertTag(PA_TAG.ARBITRARY)
    this.assertReadable(4)
    const length = this.view.getUint32(this.offset, false)
    this.offset += 4
    this.assertReadable(length)
    const value = this.body.slice(this.offset, this.offset + length)
    this.offset += length
    return value
  }

  getBool(): boolean {
    this.assertReadable(1)
    const tag = this.body[this.offset]!
    if (tag === PA_TAG.BOOLEAN_TRUE) {
      this.offset += 1
      return true
    }
    if (tag === PA_TAG.BOOLEAN_FALSE) {
      this.offset += 1
      return false
    }
    throw new Error(`invalid bool tag: ${tag}`)
  }

  getSampleSpec(): SampleSpec {
    this.assertTag(PA_TAG.SAMPLE_SPEC)
    this.assertReadable(6)
    const format = this.body[this.offset]!
    if (!isSampleFormat(format)) {
      throw new Error(`invalid sample format: ${format}`)
    }
    this.offset += 1
    const channels = this.body[this.offset]!
    this.offset += 1
    const rate = this.view.getUint32(this.offset, false)
    this.offset += 4
    return { format, channels, rate }
  }

  getChannelMap(): ChannelMap {
    this.assertTag(PA_TAG.CHANNEL_MAP)
    this.assertReadable(1)
    const channels = this.body[this.offset]!
    this.offset += 1
    this.assertReadable(channels)
    const map = Array.from(this.body.slice(this.offset, this.offset + channels))
    this.offset += channels
    return map
  }

  getProps(): Readonly<Record<string, string>> {
    this.assertTag(PA_TAG.PROPLIST)

    const props: Record<string, string> = {}
    let key = this.getString()

    while (key !== null) {
      this.getUInt32()
      const value = this.getArbitrary()
      const withoutTerminator =
        value.length > 0 && value[value.length - 1] === 0 ? value.slice(0, value.length - 1) : value
      props[key] = decoder.decode(withoutTerminator)
      key = this.getString()
    }

    return props
  }

  getCvolume(): ReadonlyArray<number> {
    this.assertTag(PA_TAG.CVOLUME)
    this.assertReadable(1)
    const channels = this.body[this.offset]!
    this.offset += 1
    this.assertReadable(channels * 4)
    const volumes: Array<number> = []
    for (let index = 0; index < channels; index += 1) {
      volumes.push(this.view.getUint32(this.offset, false))
      this.offset += 4
    }
    return volumes
  }

  getVolume(): number {
    this.assertTag(PA_TAG.VOLUME)
    this.assertReadable(4)
    const volume = this.view.getUint32(this.offset, false)
    this.offset += 4
    return volume
  }

  getFormatInfo(): {
    readonly encoding: number
    readonly properties: Readonly<Record<string, string>>
  } {
    this.assertTag(PA_TAG.FORMAT_INFO)
    return {
      encoding: this.getUInt8(),
      properties: this.getProps(),
    }
  }

  hasRemaining(): boolean {
    return this.offset < this.body.length
  }

  remainingBytes(): Uint8Array {
    return this.body.slice(this.offset)
  }
}
