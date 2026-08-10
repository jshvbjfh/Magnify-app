import sharp from 'sharp'
import { writeFileSync } from 'fs'

const SRC = 'c:/Users/HP/Documents/restaurant-app/waiter-app-desktop/public/icon.png'
const OUT = 'c:/Users/HP/Documents/restaurant-app/waiter-app-desktop/public/icon.ico'
const SIZES = [16, 24, 32, 48, 64, 128, 256]

const pngBuffers = await Promise.all(
  SIZES.map(size => sharp(SRC).resize(size, size, { fit: 'contain' }).png().toBuffer())
)

// Assemble a standard ICO: 6-byte header, 16-byte directory entry per image, then raw PNG data per image.
const HEADER_SIZE = 6
const ENTRY_SIZE = 16
const dirSize = ENTRY_SIZE * SIZES.length
let dataOffset = HEADER_SIZE + dirSize

const header = Buffer.alloc(HEADER_SIZE)
header.writeUInt16LE(0, 0) // reserved
header.writeUInt16LE(1, 2) // type: icon
header.writeUInt16LE(SIZES.length, 4) // image count

const entries = []
for (let i = 0; i < SIZES.length; i++) {
  const size = SIZES[i]
  const buf = pngBuffers[i]
  const entry = Buffer.alloc(ENTRY_SIZE)
  entry.writeUInt8(size === 256 ? 0 : size, 0) // width (0 = 256)
  entry.writeUInt8(size === 256 ? 0 : size, 1) // height (0 = 256)
  entry.writeUInt8(0, 2) // color palette
  entry.writeUInt8(0, 3) // reserved
  entry.writeUInt16LE(1, 4) // color planes
  entry.writeUInt16LE(32, 6) // bits per pixel
  entry.writeUInt32LE(buf.length, 8) // image data size
  entry.writeUInt32LE(dataOffset, 12) // offset
  dataOffset += buf.length
  entries.push(entry)
}

const ico = Buffer.concat([header, ...entries, ...pngBuffers])
writeFileSync(OUT, ico)
console.log('Wrote', OUT, ico.length, 'bytes, sizes:', SIZES.join(','))
