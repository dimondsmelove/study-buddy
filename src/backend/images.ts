import { GATEWAY_LIMITS } from '../shared/gateway-protocol'

export type ImageValidationCode = 'image.invalid' | 'image.too_large'

export class ImageValidationError extends Error {
  constructor(readonly code: ImageValidationCode) {
    super(code)
    this.name = 'ImageValidationError'
  }
}

export interface ValidatedImage {
  dataUrl: string
  byteLength: number
}

/** Accept only inline base64 images with bounded dimensions. The gateway never
 * downloads URLs or decompresses image pixels, so validation work is bounded
 * by the 4 MiB encoded image limit and header scan. */
export function validateImageDataUrl(value: string): ValidatedImage {
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]*={0,2})$/i.exec(value)
  if (!match) throw new ImageValidationError('image.invalid')
  const [, mediaType, encoded] = match
  const bytes = Buffer.from(encoded, 'base64')
  if (!bytes.length || bytes.toString('base64') !== encoded) throw new ImageValidationError('image.invalid')
  if (bytes.byteLength > GATEWAY_LIMITS.imageBytes) throw new ImageValidationError('image.too_large')
  const format = mediaType.toLowerCase()
  const valid = format === 'png'
    ? validPng(bytes)
    : format === 'jpeg'
      ? validJpeg(bytes)
      : validWebp(bytes)
  if (!valid) throw new ImageValidationError('image.invalid')
  return { dataUrl: 'data:image/' + format + ';base64,' + encoded, byteLength: bytes.byteLength }
}

function validPng(bytes: Buffer): boolean {
  if (bytes.length < 45 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return false
  let offset = 8
  let sawHeader = false
  let sawData = false
  let sawEnd = false
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset)
    const end = offset + 12 + length
    if (end > bytes.length) return false
    const type = bytes.toString('ascii', offset + 4, offset + 8)
    const data = bytes.subarray(offset + 8, offset + 8 + length)
    const crc = bytes.readUInt32BE(offset + 8 + length)
    if (crc32(bytes.subarray(offset + 4, offset + 8), data) !== crc) return false
    if (!sawHeader) {
      if (type !== 'IHDR' || length !== 13) return false
      if (!saneDimensions(data.readUInt32BE(0), data.readUInt32BE(4))) return false
      sawHeader = true
    } else if (type === 'IHDR') return false
    if (type === 'IDAT') sawData = true
    offset = end
    if (type === 'IEND') {
      if (length !== 0 || !sawData || offset !== bytes.length) return false
      sawEnd = true
      break
    }
  }
  return sawHeader && sawData && sawEnd
}

function validJpeg(bytes: Buffer): boolean {
  if (bytes.length < 16 || bytes[0] !== 0xff || bytes[1] !== 0xd8 ||
      bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) return false
  let offset = 2
  let sawFrame = false
  while (offset < bytes.length - 2) {
    if (bytes[offset] !== 0xff) return false
    while (bytes[offset] === 0xff) offset++
    const marker = bytes[offset++]
    if (marker === 0xd9) break
    if (marker === 0xda) return sawFrame && offset + 2 <= bytes.length - 2
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (offset + 2 > bytes.length - 2) return false
    const length = bytes.readUInt16BE(offset)
    if (length < 2 || offset + length > bytes.length - 2) return false
    if (isJpegFrame(marker)) {
      if (length < 8) return false
      const height = bytes.readUInt16BE(offset + 3)
      const width = bytes.readUInt16BE(offset + 5)
      if (!saneDimensions(width, height)) return false
      sawFrame = true
    }
    offset += length
  }
  return sawFrame
}

function isJpegFrame(marker: number): boolean {
  return (marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) ||
    (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)
}

function validWebp(bytes: Buffer): boolean {
  if (bytes.length < 20 || bytes.toString('ascii', 0, 4) !== 'RIFF' ||
      bytes.readUInt32LE(4) + 8 !== bytes.length || bytes.toString('ascii', 8, 12) !== 'WEBP') return false
  let offset = 12
  let dimensionsValid = false
  while (offset + 8 <= bytes.length) {
    const type = bytes.toString('ascii', offset, offset + 4)
    const size = bytes.readUInt32LE(offset + 4)
    const data = offset + 8
    const end = data + size + (size & 1)
    if (end > bytes.length) return false
    if (type === 'VP8X') {
      if (size < 10) return false
      const width = readUInt24LE(bytes, data + 4) + 1
      const height = readUInt24LE(bytes, data + 7) + 1
      if (!saneDimensions(width, height)) return false
      dimensionsValid = true
    } else if (type === 'VP8 ') {
      if (size < 10 || bytes[data + 3] !== 0x9d || bytes[data + 4] !== 0x01 || bytes[data + 5] !== 0x2a) return false
      const width = bytes.readUInt16LE(data + 6) & 0x3fff
      const height = bytes.readUInt16LE(data + 8) & 0x3fff
      if (!saneDimensions(width, height)) return false
      dimensionsValid = true
    } else if (type === 'VP8L') {
      if (size < 5 || bytes[data] !== 0x2f) return false
      const b1 = bytes[data + 1]
      const b2 = bytes[data + 2]
      const b3 = bytes[data + 3]
      const b4 = bytes[data + 4]
      const width = 1 + b1 + ((b2 & 0x3f) << 8)
      const height = 1 + ((b2 & 0xc0) >> 6) + (b3 << 2) + ((b4 & 0x0f) << 10)
      if (!saneDimensions(width, height)) return false
      dimensionsValid = true
    }
    offset = end
  }
  return dimensionsValid && offset === bytes.length
}

function readUInt24LE(bytes: Buffer, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16)
}

function saneDimensions(width: number, height: number): boolean {
  return Number.isInteger(width) && Number.isInteger(height) &&
    width > 0 && height > 0 && width <= 16_384 && height <= 16_384 &&
    width * height <= 40_000_000
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0)
  return value >>> 0
})

function crc32(type: Buffer, data: Buffer): number {
  let crc = 0xffffffff
  for (const bytes of [type, data]) {
    for (const byte of bytes) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff]
  }
  return (crc ^ 0xffffffff) >>> 0
}
