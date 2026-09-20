/**
 * Image preparation for stamping: remove a flat background to transparency and
 * optionally crop to the remaining ink.
 *
 * Why this exists: signature and seal images are usually exported as *opaque*
 * images on a solid (usually white) background. Placing two of those on a page
 * makes each one's background rectangle hide what is underneath — so a seal
 * drawn over a signature erases the signature, and anything drawn over page
 * content whitens it. Keying the background out is what makes stacking possible
 * at all, and it is the difference between a stamp that looks stamped and one
 * that looks like a pasted screenshot.
 *
 * Colour fidelity: a naive "white → alpha" conversion lightens ink, because the
 * pixel keeps its washed-out edge colour while losing the white it was
 * composited against. This module un-composites instead — for each pixel it
 * solves `C = I·a + B·(1−a)` for the ink colour `I` given the recovered alpha
 * `a` and the known background `B`, so the result over a white page reproduces
 * the original pixel exactly.
 * @module dsh-pdf-sign/image-prep
 */
import { deflateSync, inflateSync } from 'node:zlib'

/** Alpha values at or below this are treated as fully transparent when trimming. */
const TRIM_ALPHA_THRESHOLD = 8

/** A background darker than this cannot be keyed by the light-background formula. */
const MIN_KEYABLE_BACKGROUND = 32

// ---------------------------------------------------------------- PNG decode

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

/** CRC-32 as PNG chunks require. */
function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** Serialize one PNG chunk (length, type, data, CRC). */
function pngChunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const typeAndData = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typeAndData))
  return Buffer.concat([length, typeAndData, crc])
}

/**
 * Decode a PNG to straight RGBA.
 *
 * Supports the 8-bit non-interlaced colour types that signature images use
 * (grey, RGB, grey+alpha, RGBA). Interlaced and 16-bit files are rejected with
 * an actionable message rather than decoded wrongly.
 * @param bytes - the PNG file bytes.
 * @returns width, height and an RGBA pixel buffer.
 */
export function decodePng(bytes) {
  let offset = 8
  const chunks = []
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset)
    const type = bytes.toString('latin1', offset + 4, offset + 8)
    chunks.push({ type, data: bytes.subarray(offset + 8, offset + 8 + length) })
    offset += 12 + length
    if (type === 'IEND') break
  }
  const header = chunks.find((c) => c.type === 'IHDR')
  if (header === undefined) throw new Error('not a PNG: no IHDR chunk')
  const width = header.data.readUInt32BE(0)
  const height = header.data.readUInt32BE(4)
  const bitDepth = header.data[8]
  const colorType = header.data[9]
  const interlace = header.data[12]

  if (interlace !== 0) {
    throw new Error('interlaced (Adam7) PNGs are not supported; re-save the image as a non-interlaced PNG')
  }
  if (bitDepth !== 8) {
    throw new Error(`unsupported PNG bit depth ${bitDepth}; re-save the image as an 8-bit PNG`)
  }
  const channelsByType = { 0: 1, 2: 3, 4: 2, 6: 4 }
  const channels = channelsByType[colorType]
  if (channels === undefined) {
    throw new Error(`unsupported PNG colour type ${colorType}; use greyscale, RGB, or an alpha variant`)
  }

  const idat = Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data))
  const raw = inflateSync(idat)
  const bpp = channels
  const stride = width * bpp
  const out = Buffer.alloc(height * stride)
  let prev = Buffer.alloc(stride)
  let p = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[p++]
    const line = raw.subarray(p, p + stride)
    p += stride
    const cur = Buffer.alloc(stride)
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0
      const b = prev[x]
      const c = x >= bpp ? prev[x - bpp] : 0
      let v = line[x]
      if (filter === 1) v += a
      else if (filter === 2) v += b
      else if (filter === 3) v += (a + b) >> 1
      else if (filter === 4) {
        const pa = Math.abs(b - c)
        const pb = Math.abs(a - c)
        const pc = Math.abs(a + b - 2 * c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      cur[x] = v & 0xff
    }
    cur.copy(out, y * stride)
    prev = cur
  }

  // Normalize to RGBA so every later stage sees one layout.
  const rgba = Buffer.alloc(width * height * 4)
  for (let i = 0, n = width * height; i < n; i++) {
    const s = i * channels
    const d = i * 4
    if (channels === 1) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = out[s]
      rgba[d + 3] = 255
    } else if (channels === 2) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = out[s]
      rgba[d + 3] = out[s + 1]
    } else if (channels === 3) {
      rgba[d] = out[s]; rgba[d + 1] = out[s + 1]; rgba[d + 2] = out[s + 2]
      rgba[d + 3] = 255
    } else {
      rgba[d] = out[s]; rgba[d + 1] = out[s + 1]; rgba[d + 2] = out[s + 2]; rgba[d + 3] = out[s + 3]
    }
  }
  return { width, height, rgba }
}

/** Encode straight RGBA as an 8-bit PNG (one filter byte per scanline). */
export function encodeRgbaPng(width, height, rgba) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  const stride = width * 4
  const filtered = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    filtered[y * (stride + 1)] = 0 // filter: None
    rgba.copy(filtered, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(filtered, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

/**
 * Decode a JPEG to straight RGBA. jpeg-js is loaded lazily so a PNG-only setup
 * still works if the dependency is unavailable.
 * @param bytes - the JPEG file bytes.
 * @returns width, height and an RGBA pixel buffer.
 */
export async function decodeJpeg(bytes) {
  let jpeg
  try {
    jpeg = (await import('jpeg-js')).default ?? (await import('jpeg-js'))
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(
      `reading a JPEG needs the jpeg-js dependency (${reason}); ` +
      'convert the image to PNG, or install jpeg-js'
    )
  }
  const decoded = jpeg.decode(bytes, { useTArray: true, maxMemoryUsageInMB: 1024 })
  return { width: decoded.width, height: decoded.height, rgba: Buffer.from(decoded.data.buffer, decoded.data.byteOffset, decoded.data.length) }
}

// ------------------------------------------------------- background handling

/** How much of the image sits within tolerance of its own border colour. */
function borderCoverage(rgba, width, height, target, tolerance) {
  let hits = 0
  let total = 0
  const ring = Math.max(1, Math.min(3, Math.floor(Math.min(width, height) / 20)))
  const consider = (x, y) => {
    const i = (y * width + x) * 4
    total++
    if (
      Math.abs(rgba[i] - target[0]) <= tolerance &&
      Math.abs(rgba[i + 1] - target[1]) <= tolerance &&
      Math.abs(rgba[i + 2] - target[2]) <= tolerance
    ) hits++
  }
  for (let x = 0; x < width; x++) {
    for (let d = 0; d < ring; d++) {
      consider(x, d)
      consider(x, height - 1 - d)
    }
  }
  for (let y = 0; y < height; y++) {
    for (let d = 0; d < ring; d++) {
      consider(d, y)
      consider(width - 1 - d, y)
    }
  }
  return total === 0 ? 0 : hits / total
}

/**
 * Find the image's background colour as the DOMINANT colour on its border ring.
 *
 * Deliberately a mode, not a mean: when the subject touches the canvas edge (a
 * stroke running off the side, or a tight crop), those ink pixels land inside
 * the ring and drag a mean toward grey — a mean of a light background with 5%
 * ink reads ~12 levels too dark, which then keys the wrong colour. The
 * background is by definition whatever colour most of the border already is, so
 * the most frequent colour is the right estimator.
 * @returns the dominant border colour, how much of the border matches it, and
 *   that colour's share of the ring.
 */
export function detectBackground(rgba, width, height, tolerance = 28) {
  const ring = Math.max(1, Math.min(3, Math.floor(Math.min(width, height) / 20)))
  const samples = []
  const add = (x, y) => {
    const i = (y * width + x) * 4
    samples.push(rgba[i], rgba[i + 1], rgba[i + 2])
  }
  for (let x = 0; x < width; x++) {
    for (let d = 0; d < ring; d++) {
      add(x, d); add(x, height - 1 - d)
    }
  }
  for (let y = 0; y < height; y++) {
    for (let d = 0; d < ring; d++) {
      add(d, y); add(width - 1 - d, y)
    }
  }

  // Histogram on a 32-level quantisation, then average the winning bucket for precision.
  const buckets = new Map()
  for (let i = 0; i < samples.length; i += 3) {
    const r = samples[i], g = samples[i + 1], b = samples[i + 2]
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)
    const entry = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 }
    entry.n++; entry.r += r; entry.g += g; entry.b += b
    buckets.set(key, entry)
  }
  let best
  for (const entry of buckets.values()) if (best === undefined || entry.n > best.n) best = entry
  const color = [Math.round(best.r / best.n), Math.round(best.g / best.n), Math.round(best.b / best.n)]

  return {
    color,
    uniformity: borderCoverage(rgba, width, height, color, tolerance),
    dominantShare: best.n / (samples.length / 3)
  }
}

/** Parse '#rrggbb' or 'r,g,b' (0-255 or 0-1) into a byte triple. */
export function parseColor(input) {
  if (typeof input !== 'string') throw new Error('background colour must be a string')
  const hex = input.trim().replace(/^#/, '')
  if (/^[0-9a-fA-F]{6}$/.test(hex)) {
    return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)]
  }
  const parts = input.split(',').map((s) => Number(s.trim()))
  if (parts.length === 3 && parts.every((v) => Number.isFinite(v))) {
    return parts.map((v) => (v <= 1 ? Math.round(v * 255) : Math.round(v)))
  }
  throw new Error(`cannot parse colour "${input}"; use "#rrggbb" or "r,g,b"`)
}

/**
 * Key a flat light background out to transparency.
 *
 * Alpha is recovered from how far a pixel sits below the background's darkest
 * channel, which keeps anti-aliased edges smooth; the stored colour is then
 * un-composited so the pixel reproduces its original value over a white page.
 * @param rgba - RGBA pixels (modified in place).
 * @returns how many pixels became fully transparent.
 */
export function keyOutBackground(rgba, width, height, background, tolerance = 28) {
  const bgMin = Math.min(background[0], background[1], background[2])
  if (bgMin < MIN_KEYABLE_BACKGROUND) {
    throw new Error(
      `background rgb(${background.join(',')}) is too dark to key out ` +
      `(needs a light background, darkest channel >= ${MIN_KEYABLE_BACKGROUND})`
    )
  }
  let cleared = 0
  for (let i = 0, n = width * height; i < n; i++) {
    const o = i * 4
    const r = rgba[o], g = rgba[o + 1], b = rgba[o + 2]
    // Near-background pixels (within tolerance of the sampled colour) go fully clear.
    const near =
      Math.abs(r - background[0]) <= tolerance &&
      Math.abs(g - background[1]) <= tolerance &&
      Math.abs(b - background[2]) <= tolerance
    const key = Math.min(r, g, b)
    let a = near ? 0 : (bgMin - key) / bgMin
    if (a < 0) a = 0
    else if (a > 1) a = 1
    if (a <= 0.003) {
      rgba[o] = 255; rgba[o + 1] = 255; rgba[o + 2] = 255; rgba[o + 3] = 0
      cleared++
      continue
    }
    // Un-composite: C = I·a + B·(1−a)  ->  I = (C − B·(1−a)) / a
    const inv = 1 - a
    const un = (c, k) => {
      const v = (c - k * inv) / a
      return v < 0 ? 0 : v > 255 ? 255 : Math.round(v)
    }
    rgba[o] = un(r, background[0])
    rgba[o + 1] = un(g, background[1])
    rgba[o + 2] = un(b, background[2])
    rgba[o + 3] = Math.round(a * 255)
  }
  return cleared
}

/**
 * Crop to the tight bounds of visible pixels.
 * @returns the cropped RGBA buffer plus the box that was kept.
 */
export function trimTransparent(rgba, width, height, threshold = TRIM_ALPHA_THRESHOLD) {
  let minX = width, minY = height, maxX = -1, maxY = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (rgba[(y * width + x) * 4 + 3] > threshold) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0) return { rgba, width, height, box: { x: 0, y: 0, width, height }, empty: true }
  const cw = maxX - minX + 1
  const ch = maxY - minY + 1
  if (cw === width && ch === height) {
    return { rgba, width, height, box: { x: 0, y: 0, width, height }, empty: false }
  }
  const out = Buffer.alloc(cw * ch * 4)
  for (let y = 0; y < ch; y++) {
    rgba.copy(out, y * cw * 4, ((y + minY) * width + minX) * 4, ((y + minY) * width + minX + cw) * 4)
  }
  return { rgba: out, width: cw, height: ch, box: { x: minX, y: minY, width: cw, height: ch }, empty: false }
}

/** Fraction of pixels that are fully opaque and very light — an unkeyed background. */
export function opaqueLightFraction(rgba, width, height, threshold = 245) {
  let hits = 0
  for (let i = 0, n = width * height; i < n; i++) {
    const o = i * 4
    if (rgba[o + 3] > 250 && rgba[o] >= threshold && rgba[o + 1] >= threshold && rgba[o + 2] >= threshold) hits++
  }
  return hits / (width * height)
}

/**
 * Prepare a source image for stamping: decode, optionally key out a background,
 * then optionally trim to the ink.
 *
 * `background` accepts `'none'`, `'white'`, `'auto'` (sample the border) or an
 * explicit colour.
 * @returns PNG bytes ready to embed, plus a report of what changed.
 */
export async function prepareImageForStamping(bytes, kind, options = {}) {
  const {
    background = 'none',
    tolerance = 28,
    trim = true
  } = options

  const decoded = kind === 'jpg' ? await decodeJpeg(bytes) : decodePng(bytes)
  let { width, height, rgba } = decoded

  const alreadyHasAlpha = rgba.some((v, i) => i % 4 === 3 && v < 250)
  const lightFraction = opaqueLightFraction(rgba, width, height)
  const report = {
    width,
    height,
    backgroundRemoved: false,
    backgroundColor: null,
    backgroundCoverage: null,
    trimmed: false,
    trimBox: null,
    transparentPixels: 0,
    alreadyHasAlpha,
    opaqueLightFraction: lightFraction,
    note: undefined
  }

  if (background !== 'none') {
    let target
    if (background === 'white') target = [255, 255, 255]
    else if (background === 'auto') {
      const detected = detectBackground(rgba, width, height, tolerance)
      target = detected.color
      report.backgroundCoverage = detected.uniformity
    } else target = parseColor(background)

    report.transparentPixels = keyOutBackground(rgba, width, height, target, tolerance)
    report.backgroundRemoved = true
    report.backgroundColor = target
  } else if (lightFraction >= 0.9) {
    // A background that was never keyed will hide whatever sits beneath it.
    report.note =
      `this image is fully opaque and ${(lightFraction * 100).toFixed(0)}% near-white, so its background rectangle ` +
      'will cover anything underneath it (a seal placed over a signature would erase it). ' +
      "Pass drop_background: \"white\" (or \"auto\") to key the background out to transparency."
  }

  let outWidth = width
  let outHeight = height
  if (trim && (report.backgroundRemoved || report.alreadyHasAlpha)) {
    const t = trimTransparent(rgba, width, height)
    if (!t.empty) {
      rgba = t.rgba
      outWidth = t.width
      outHeight = t.height
      report.trimmed = t.width !== width || t.height !== height
      report.trimBox = t.box
    }
  }

  report.width = outWidth
  report.height = outHeight
  return { png: encodeRgbaPng(outWidth, outHeight, rgba), report }
}
