/**
 * Signature image generation: build a handwritten-style SVG from text and
 * rasterize it to PNG.
 *
 * The SVG is always produced and is itself a usable vector signature. PNG
 * rasterization needs the optional native `@resvg/resvg-js` binding; when that
 * is unavailable the caller still receives the SVG plus a clear reason.
 * @module dsh-pdf-sign/signature
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'

/** Ink presets: a signature is normally blue-black, black, or red. */
export const INK_COLORS = {
  'blue-black': '#1a237e',
  black: '#111111',
  blue: '#0d47a1',
  red: '#b71c1c'
}

/**
 * Handwriting-leaning font candidates per platform, in preference order.
 * These render a personal name far more convincingly than a UI sans-serif,
 * and all are widely present on their platform.
 */
const FONT_CANDIDATES = {
  win32: [
    'C:\\Windows\\Fonts\\simkai.ttf', // 楷体 — brush-like, ideal for signatures
    'C:\\Windows\\Fonts\\kaiu.ttf', // 标楷体
    'C:\\Windows\\Fonts\\STXINGKA.TTF', // 华文行楷
    'C:\\Windows\\Fonts\\msyh.ttc',
    'C:\\Windows\\Fonts\\simsun.ttc'
  ],
  darwin: [
    '/System/Library/Fonts/Supplemental/Songti.ttc',
    '/System/Library/Fonts/Supplemental/Kai.ttf',
    '/System/Library/Fonts/PingFang.ttc',
    '/Library/Fonts/Arial Unicode.ttf'
  ],
  linux: [
    '/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc',
    '/usr/share/fonts/truetype/arphic/ukai.ttc',
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
  ]
}

/** Font-family name to hand resvg for a given font file (declared in the SVG too). */
const FAMILY_BY_BASENAME = {
  'simkai.ttf': 'SimKai',
  'kaiu.ttf': 'DFKai-SB',
  'stxingka.ttf': 'STXingkai',
  'msyh.ttc': 'Microsoft YaHei',
  'simsun.ttc': 'SimSun',
  'songti.ttc': 'Songti SC',
  'kai.ttf': 'Kai',
  'pingfang.ttc': 'PingFang SC',
  'ukai.ttc': 'AR PL UKai CN',
  'notoserifcjk-regular.ttc': 'Noto Serif CJK SC',
  'notosanscjk-regular.ttc': 'Noto Sans CJK SC',
  'dejavusans.ttf': 'DejaVu Sans',
  'arial unicode.ttf': 'Arial Unicode MS'
}

/**
 * Locate a usable font file: an explicit path wins, otherwise the first
 * existing platform candidate.
 * @param explicit - user-supplied font file path, if any.
 * @returns the chosen font path and its declared family name, or undefined.
 */
export function resolveFont(explicit) {
  if (explicit !== undefined && explicit.length > 0) {
    if (!existsSync(explicit)) throw new Error(`font file not found: ${explicit}`)
    return { path: explicit, family: familyFor(explicit) }
  }
  for (const candidate of FONT_CANDIDATES[process.platform] ?? []) {
    if (existsSync(candidate)) return { path: candidate, family: familyFor(candidate) }
  }
  return undefined
}

/** Best-effort family name for a font file basename. */
function familyFor(filePath) {
  const base = filePath.replace(/\\/g, '/').split('/').pop().toLowerCase()
  return FAMILY_BY_BASENAME[base] ?? base.replace(/\.(ttf|ttc|otf)$/i, '')
}

/** Deterministic PRNG so the same text always yields the same signature. */
function seededRandom(seed) {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return () => {
    h ^= h << 13; h >>>= 0
    h ^= h >> 17
    h ^= h << 5; h >>>= 0
    return (h >>> 0) / 4294967296
  }
}

/** Whether a code point is a CJK ideograph (rendered roughly square). */
function isWide(ch) {
  const c = ch.codePointAt(0)
  return (
    (c >= 0x2e80 && c <= 0x9fff) ||
    (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0xff00 && c <= 0xff60) ||
    (c >= 0x3000 && c <= 0x303f)
  )
}

/**
 * Build a handwritten-feeling signature SVG.
 *
 * Each glyph is emitted as its own rotated, vertically jittered `<text>` node
 * instead of one flat run, which is what makes the result read as handwriting
 * rather than typesetting. Jitter is seeded by the text, so a given name always
 * produces the identical signature — important when a document is re-signed.
 * @param options - text, size, ink, rotation, jitter and flourish controls.
 * @returns SVG markup and the intrinsic canvas size.
 */
export function buildSignatureSvg(options) {
  const {
    text,
    fontSize = 120,
    color = INK_COLORS['blue-black'],
    rotate = -2.5,
    jitter = 1,
    underline = true,
    padding = 0.35,
    fontFamily = 'sans-serif',
    letterSpacing = 0
  } = options

  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new Error('signature text must be a non-empty string')
  }
  const chars = [...text]
  const rand = seededRandom(text)

  // Lay glyphs out on their own advances so per-character jitter never overlaps.
  const advances = chars.map((ch) => (isWide(ch) ? fontSize : fontSize * 0.58))
  const textWidth = advances.reduce((a, b) => a + b, 0) + letterSpacing * Math.max(0, chars.length - 1)

  const pad = fontSize * padding
  const canvasW = Math.ceil(textWidth + pad * 2)
  const canvasH = Math.ceil(fontSize * 1.85)

  const parts = []
  let x = pad
  const baseline = canvasH * 0.66
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]
    const dy = jitter === 0 ? 0 : (rand() - 0.5) * fontSize * 0.05 * jitter
    const dr = jitter === 0 ? 0 : (rand() - 0.5) * 3.2 * jitter
    const esc = ch.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    parts.push(
      `<text x="${x.toFixed(2)}" y="${(baseline + dy).toFixed(2)}" ` +
      `font-family="${fontFamily}" font-size="${fontSize}" fill="${color}" ` +
      `transform="rotate(${dr.toFixed(2)} ${x.toFixed(2)} ${(baseline + dy).toFixed(2)})">${esc}</text>`
    )
    x += advances[i] + letterSpacing
  }

  // A trailing pen stroke reads as a hand-drawn finish.
  let flourish = ''
  if (underline) {
    const y0 = baseline + fontSize * 0.22
    const x0 = pad * 0.55
    const x1 = Math.min(canvasW - pad * 0.3, textWidth + pad * 1.15)
    const y1 = y0 - fontSize * 0.05
    flourish =
      `<path d="M ${x0.toFixed(1)} ${(y0 + fontSize * 0.3).toFixed(1)} ` +
      `C ${(x0 + (x1 - x0) * 0.25).toFixed(1)} ${(y0 - fontSize * 0.18).toFixed(1)}, ` +
      `${(x0 + (x1 - x0) * 0.7).toFixed(1)} ${(y1 + fontSize * 0.34).toFixed(1)}, ` +
      `${x1.toFixed(1)} ${y1.toFixed(1)}" ` +
      `stroke="${color}" stroke-width="${(fontSize * 0.022).toFixed(2)}" fill="none" opacity="0.85"/>`
  }

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasW}" height="${canvasH}" ` +
    `viewBox="0 0 ${canvasW} ${canvasH}">` +
    `<g transform="rotate(${rotate} ${(canvasW / 2).toFixed(1)} ${(canvasH / 2).toFixed(1)})">` +
    parts.join('') + flourish +
    `</g></svg>`

  return { svg, width: canvasW, height: canvasH }
}

/**
 * Rasterize signature SVG to PNG through the optional native resvg binding.
 * @param svg - the SVG markup to render.
 * @param width - target PNG width in pixels.
 * @param fontPath - font file to load for glyph rendering.
 * @returns PNG bytes plus rendered pixel size and the rasterizer that produced them.
 */
export async function rasterizeSvg(svg, width, fontPath) {
  let Resvg
  try {
    ;({ Resvg } = await import('@resvg/resvg-js'))
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { ok: false, reason: `@resvg/resvg-js unavailable: ${reason}` }
  }
  const font = fontPath !== undefined
    ? { fontFiles: [fontPath], loadSystemFonts: true, defaultFontFamily: familyFor(fontPath) }
    : { loadSystemFonts: true }
  try {
    const renderer = new Resvg(svg, {
      background: 'rgba(0,0,0,0)',
      fitTo: { mode: 'width', value: Math.max(1, Math.round(width)) },
      font
    })
    const rendered = renderer.render()
    return { ok: true, png: rendered.asPng(), width: rendered.width, height: rendered.height }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { ok: false, reason: `resvg render failed: ${reason}` }
  }
}

/**
 * Generate a signature image on disk.
 *
 * Writes PNG when the rasterizer is available and `format` allows it; otherwise
 * falls back to the SVG so the caller always gets a usable artifact.
 * @param options - generation options, including the target path.
 * @returns the written artifact's path, format, size and rasterizer status.
 */
export async function generateSignatureImage(options) {
  const { outputPath, format = 'png', width, fontFile } = options
  if (typeof outputPath !== 'string' || outputPath.length === 0) {
    throw new Error('outputPath is required')
  }
  const font = resolveFont(fontFile)
  const built = buildSignatureSvg({
    ...options,
    fontFamily: font?.family ?? options.fontFamily ?? 'sans-serif'
  })

  const wantsPng = format !== 'svg'
  if (wantsPng) {
    const raster = await rasterizeSvg(built.svg, width ?? built.width, font?.path)
    if (raster.ok) {
      writeFileSync(outputPath, raster.png)
      return {
        path: outputPath,
        format: 'png',
        width: raster.width,
        height: raster.height,
        bytes: raster.png.length,
        fontPath: font?.path ?? null,
        rasterized: true,
        svgFallbackPath: null
      }
    }
    // Degrade to SVG next to the requested path, and say why.
    const svgPath = outputPath.replace(/\.(png|jpe?g)$/i, '') + '.svg'
    writeFileSync(svgPath, built.svg, 'utf8')
    return {
      path: svgPath,
      format: 'svg',
      width: built.width,
      height: built.height,
      bytes: Buffer.byteLength(built.svg, 'utf8'),
      fontPath: font?.path ?? null,
      rasterized: false,
      svgFallbackPath: svgPath,
      note: `${raster.reason}; wrote SVG instead (PNG needs the optional native @resvg/resvg-js binding)`
    }
  }

  const svgPath = extname(outputPath).toLowerCase() === '.svg' ? outputPath : outputPath + '.svg'
  writeFileSync(svgPath, built.svg, 'utf8')
  return {
    path: svgPath,
    format: 'svg',
    width: built.width,
    height: built.height,
    bytes: Buffer.byteLength(built.svg, 'utf8'),
    fontPath: font?.path ?? null,
    rasterized: false,
    svgFallbackPath: null
  }
}

/** Read a signature image and report its format for embedding. */
export function readSignatureImage(imagePath) {
  if (!existsSync(imagePath)) throw new Error(`signature image not found: ${imagePath}`)
  const bytes = readFileSync(imagePath)
  const lower = imagePath.toLowerCase()
  let kind
  if (lower.endsWith('.png') || (bytes[0] === 0x89 && bytes[1] === 0x50)) kind = 'png'
  else if (lower.endsWith('.jpg') || lower.endsWith('.jpeg') || bytes[0] === 0xff) kind = 'jpg'
  else throw new Error(`unsupported signature image format (need PNG or JPEG): ${imagePath}`)
  return { bytes, kind }
}
