/**
 * Visual PDF signing: place a signature image and/or a typed signature block on
 * PDF pages.
 *
 * This is a *visual* signature — it renders ink on the page and carries no
 * cryptographic guarantee. Use {@link module:dsh-pdf-sign/digital} when the
 * document needs a verifiable digital signature.
 *
 * Text handling note: pdf-lib's standard fonts are WinAnsi-encoded and cannot
 * represent CJK or other non-Latin-1 text at all. Any such text is therefore
 * drawn with a subset-embedded system TrueType font instead, which is why this
 * module needs `@pdf-lib/fontkit`.
 * @module dsh-pdf-sign/stamp
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import fontkit from '@pdf-lib/fontkit'
import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib'
import { readSignatureImage } from './signature.js'
import { prepareImageForStamping } from './image-prep.js'

/** Nine placement anchors, named as a person would describe them. */
export const ANCHORS = [
  'top-left', 'top-center', 'top-right',
  'middle-left', 'center', 'middle-right',
  'bottom-left', 'bottom-center', 'bottom-right'
]

/**
 * Embeddable CJK TrueType fonts, in preference order. Deliberately excludes
 * `.ttc` collections: subsetting a collection is unreliable through fontkit.
 */
const CJK_FONT_CANDIDATES = {
  win32: [
    'C:\\Windows\\Fonts\\simkai.ttf', // 楷体
    'C:\\Windows\\Fonts\\kaiu.ttf', // 标楷体
    'C:\\Windows\\Fonts\\simhei.ttf', // 黑体
    'C:\\Windows\\Fonts\\simfang.ttf', // 仿宋
    'C:\\Windows\\Fonts\\Deng.ttf', // 等线
    'C:\\Windows\\Fonts\\msyh.ttf'
  ],
  darwin: [
    '/System/Library/Fonts/Supplemental/Songti.ttf',
    '/Library/Fonts/Arial Unicode.ttf',
    '/System/Library/Fonts/STHeiti Light.ttc'
  ],
  linux: [
    '/usr/share/fonts/truetype/arphic/uming.ttc',
    '/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc'
  ]
}

/** True when any character falls outside WinAnsi's reachable range. */
function needsUnicodeFont(lines) {
  return lines.some((line) => /[^\u0000-\u00ff]/.test(line))
}

/**
 * Pick a font able to draw the given lines.
 *
 * Latin-1-only text uses a standard font (no embedding cost). Anything else
 * needs a real font file, so each candidate is tried until one subsets
 * successfully — platform font inventories vary too much to assume.
 * @param doc - the target document.
 * @param lines - every text line that will be drawn.
 * @returns the font plus how it was obtained.
 */
async function resolveTextFont(doc, lines) {
  if (!needsUnicodeFont(lines)) {
    return { font: await doc.embedFont(StandardFonts.Helvetica), embedded: false, fontPath: null }
  }
  doc.registerFontkit(fontkit)
  const attempts = []
  for (const candidate of CJK_FONT_CANDIDATES[process.platform] ?? []) {
    if (!existsSync(candidate)) continue
    try {
      const font = await doc.embedFont(readFileSync(candidate), { subset: true })
      return { font, embedded: true, fontPath: candidate }
    } catch (error) {
      attempts.push(`${candidate} (${error instanceof Error ? error.message : String(error)})`)
    }
  }
  throw new Error(
    'the signature text needs a Unicode font, but no embeddable CJK font could be loaded. ' +
    `Tried: ${attempts.join('; ') || '(no candidate files present on this system)'}. ` +
    'Pass an existing signature image instead, or install a CJK TrueType font.'
  )
}

/** Page selection: 1-based index, "last", or "all". */
function resolvePages(pages, total) {
  if (pages === undefined || pages === null || pages === 'last') return [total - 1]
  if (pages === 'all') return Array.from({ length: total }, (_, i) => i)
  const list = Array.isArray(pages) ? pages : [pages]
  return list.map((value) => {
    if (typeof value === 'string' && value.toLowerCase() === 'last') return total - 1
    const n = Number(value)
    if (!Number.isInteger(n) || n < 1 || n > total) {
      throw new Error(`page ${String(value)} is out of range (document has ${total} page(s); use 1..${total}, "last", or "all")`)
    }
    return n - 1
  })
}

/** Compute the lower-left draw origin for an anchored box. */
function anchorOrigin(anchor, page, boxW, boxH, margin) {
  const { width: pw, height: ph } = page.getSize()
  const [vertical, horizontal] = anchor.split('-')
  const y = vertical === 'top'
    ? ph - margin - boxH
    : vertical === 'bottom'
      ? margin
      : (ph - boxH) / 2
  const x = horizontal === 'left'
    ? margin
    : horizontal === 'right'
      ? pw - margin - boxW
      : (pw - boxW) / 2
  return { x, y }
}

/** Normalize a colour: preset name, or [r,g,b] each 0..1, or #rrggbb. */
function toRgb(input) {
  if (input === undefined) return rgb(0.12, 0.12, 0.12)
  if (Array.isArray(input) && input.length === 3) return rgb(input[0], input[1], input[2])
  if (typeof input === 'string') {
    const hex = input.replace('#', '')
    if (/^[0-9a-fA-F]{6}$/.test(hex)) {
      return rgb(
        parseInt(hex.slice(0, 2), 16) / 255,
        parseInt(hex.slice(2, 4), 16) / 255,
        parseInt(hex.slice(4, 6), 16) / 255
      )
    }
  }
  return rgb(0.12, 0.12, 0.12)
}

/**
 * Stamp a signature onto a PDF and write the result.
 * @param options - source/target paths, image and/or text content, placement.
 * @returns what was written and where each mark landed.
 */
export async function stampSignature(options) {
  const {
    pdfPath,
    outputPath,
    imagePath,
    text,
    dateText,
    pages,
    anchor = 'bottom-right',
    x,
    y,
    width,
    opacity = 1,
    rotation = 0,
    margin = 48,
    fontSize = 10,
    color,
    reason,
    dropBackground = 'none',
    dropTolerance = 28,
    trimImage = true
  } = options

  if (typeof pdfPath !== 'string' || pdfPath.length === 0) throw new Error('pdfPath is required')
  if (typeof outputPath !== 'string' || outputPath.length === 0) throw new Error('outputPath is required')
  if (imagePath === undefined && (text === undefined || String(text).trim() === '')) {
    throw new Error('nothing to stamp: provide imagePath and/or text')
  }
  if (!ANCHORS.includes(anchor) && x === undefined) {
    throw new Error(`unknown anchor "${anchor}"; use one of ${ANCHORS.join(', ')} or pass explicit x/y`)
  }

  const doc = await PDFDocument.load(readFileSync(pdfPath), { ignoreEncryption: true })
  const allPages = doc.getPages()
  const targets = resolvePages(pages, allPages.length)

  const embedded = imagePath !== undefined ? readSignatureImage(imagePath) : undefined
  let image
  let imageReport
  if (embedded !== undefined) {
    // Keying and trimming happen before embedding: an opaque background left in
    // place would hide whatever the stamp is drawn over.
    const prepared = await prepareImageForStamping(embedded.bytes, embedded.kind, {
      background: dropBackground ?? 'none',
      tolerance: dropTolerance,
      trim: trimImage
    })
    imageReport = prepared.report
    image = await doc.embedPng(prepared.png)
  }

  // The text block is identical on every stamped page, so lay it out once.
  const textLines = []
  if (text !== undefined && String(text).trim() !== '') textLines.push(String(text))
  if (dateText !== undefined && String(dateText).trim() !== '') textLines.push(String(dateText))
  if (reason !== undefined && String(reason).trim() !== '') textLines.push(String(reason))

  const inkColor = toRgb(color)
  const lineHeight = fontSize * 1.45
  const textBlockH = textLines.length * lineHeight
  const { font, embedded: fontEmbedded, fontPath } = await resolveTextFont(doc, textLines)

  const textWidth = textLines.reduce((widest, line) => Math.max(widest, font.widthOfTextAtSize(line, fontSize)), 0)
  const boxW = image !== undefined
    ? (width ?? 180)
    : Math.max(textWidth, 1)
  const imageH = image !== undefined ? boxW * (image.height / image.width) : 0
  const boxH = imageH + textBlockH

  const placements = []
  for (const pageIndex of targets) {
    const page = allPages[pageIndex]
    if (page === undefined) throw new Error(`internal: page index ${pageIndex} missing`)
    const { width: pw } = page.getSize()

    const origin = (x !== undefined || y !== undefined)
      ? { x: x ?? margin, y: y ?? margin }
      : anchorOrigin(anchor, page, boxW, boxH, margin)

    if (image !== undefined) {
      page.drawImage(image, {
        x: origin.x,
        y: origin.y + textBlockH,
        width: boxW,
        height: imageH,
        opacity,
        rotate: degrees(rotation)
      })
    }

    let ty = origin.y + textBlockH - fontSize
    for (const line of textLines) {
      page.drawText(line, { x: origin.x, y: ty, size: fontSize, font, color: inkColor, opacity })
      ty -= lineHeight
    }

    placements.push({
      page: pageIndex + 1,
      x: Math.round(origin.x * 100) / 100,
      y: Math.round(origin.y * 100) / 100,
      width: Math.round(boxW * 100) / 100,
      height: Math.round(boxH * 100) / 100,
      pageWidth: Math.round(pw * 100) / 100
    })
  }

  const bytes = await doc.save()
  writeFileSync(outputPath, bytes)

  const notes = [
    'This is a VISUAL signature (ink on the page). It carries no cryptographic guarantee; use pdf_sign_digital for a verifiable signature.'
  ]
  if (imageReport?.note !== undefined) notes.push(imageReport.note)

  return {
    path: outputPath,
    bytes: bytes.length,
    pageCount: allPages.length,
    placements,
    stampedImage: image !== undefined,
    stampedText: textLines.length > 0,
    textFontEmbedded: fontEmbedded,
    textFontPath: fontPath,
    image: imageReport === undefined
      ? undefined
      : {
          sourceWidth: imageReport.width,
          sourceHeight: imageReport.height,
          backgroundRemoved: imageReport.backgroundRemoved,
          backgroundColor: imageReport.backgroundColor,
          backgroundCoverage: imageReport.backgroundCoverage,
          transparentPixels: imageReport.transparentPixels,
          trimmed: imageReport.trimmed,
          trimBox: imageReport.trimBox
        },
    note: notes.join(' ')
  }
}
