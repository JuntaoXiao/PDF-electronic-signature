/**
 * End-to-end tests driven through the plugin's own tool surface: build a fake
 * tool registry, load the plugin, and exercise every tool for real.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { apply } = await import('../lib/index.js')
const { PDFDocument, PDFName } = await import('pdf-lib')
const { encodeRgbaPng } = await import('../lib/image-prep.js')

/** Register the plugin against a capture-only tool registry. */
function loadPlugin(config = {}) {
  const tools = new Map()
  const ctx = { tools: { register(tool) { tools.set(tool.name, tool) } } }
  apply(ctx, config)
  return tools
}

/** Call a registered tool the way the runtime would. */
async function call(tools, toolName, args) {
  const tool = tools.get(toolName)
  assert.ok(tool, `tool ${toolName} is registered`)
  return tool.execute(args, { signal: undefined })
}

/** Build a throwaway multi-page PDF. */
async function makePdf(path, pages = 1) {
  const doc = await PDFDocument.create()
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([595, 842])
    page.drawText(`Test document, page ${i + 1}`, { x: 60, y: 780, size: 14 })
  }
  writeFileSync(path, await doc.save())
  return path
}

const dir = mkdtempSync(join(tmpdir(), 'dsh-pdf-sign-'))

test('registers the documented tool set with valid definitions', () => {
  const tools = loadPlugin()
  for (const expected of [
    'pdf_signature_image',
    'pdf_sign_stamp',
    'pdf_sign_digital',
    'pdf_sign_cert_generate',
    'pdf_sign_inspect'
  ]) {
    const tool = tools.get(expected)
    assert.ok(tool, `${expected} registered`)
    assert.equal(typeof tool.description, 'string')
    assert.ok(tool.description.length > 20, `${expected} has a real description`)
    assert.equal(tool.parameters.type, 'object')
    assert.ok(tool.parameters.properties, `${expected} has parameters`)
    assert.ok(Array.isArray(tool.parameters.required), `${expected} declares required args`)
    assert.equal(typeof tool.output.schema, 'object')
    assert.equal(typeof tool.output.render, 'function')
    assert.equal(typeof tool.execute, 'function')
  }
  assert.equal(tools.size, 5)
})

test('pdf_signature_image writes a real PNG containing glyph pixels', async () => {
  const tools = loadPlugin()
  const out = join(dir, 'sig.png')
  const result = await call(tools, 'pdf_signature_image', {
    text: '肖俊涛',
    output_path: out,
    font_size: 140
  })
  assert.equal(result.format, 'png')
  assert.equal(result.rasterized, true)
  assert.ok(result.bytes > 1000, `png has content (${result.bytes} bytes)`)
  assert.ok(existsSync(out))

  // A blank render would compress to a few hundred bytes; require real ink.
  const png = readFileSync(out)
  assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'PNG magic')
  assert.ok(png.length > 3000, `PNG is large enough to hold glyphs (${png.length} bytes)`)
  assert.ok(typeof result.font_path === 'string', 'reports the font it used')
})

test('pdf_signature_image is deterministic for the same name', async () => {
  const tools = loadPlugin()
  const a = join(dir, 'det-a.png')
  const b = join(dir, 'det-b.png')
  const first = await call(tools, 'pdf_signature_image', { text: 'Juntao Xiao', output_path: a })
  const second = await call(tools, 'pdf_signature_image', { text: 'Juntao Xiao', output_path: b })
  assert.equal(first.bytes, second.bytes)
  assert.deepEqual(readFileSync(a), readFileSync(b), 'same name yields an identical signature')
})

test('pdf_signature_image rejects empty text', async () => {
  const tools = loadPlugin()
  await assert.rejects(
    () => call(tools, 'pdf_signature_image', { text: '', output_path: join(dir, 'x.png') }),
    /non-empty/
  )
})

test('pdf_sign_stamp places an image and a text block on the page', async () => {
  const tools = loadPlugin()
  const pdf = await makePdf(join(dir, 'base.pdf'))
  const sig = join(dir, 'stamp-sig.png')
  await call(tools, 'pdf_signature_image', { text: '肖俊涛', output_path: sig })

  const out = join(dir, 'stamped.pdf')
  const result = await call(tools, 'pdf_sign_stamp', {
    pdf_path: pdf,
    output_path: out,
    image_path: sig,
    text: '肖俊涛',
    date_text: '2026-09-20',
    anchor: 'bottom-right',
    width: 200
  })
  assert.equal(result.stamped_image, true)
  assert.equal(result.stamped_text, true)
  assert.equal(result.placements.length, 1)
  assert.equal(result.placements[0].page, 1)
  assert.ok(result.placements[0].x > 300, 'anchored to the right side')
  assert.ok(result.bytes > 2000)

  // The stamped PDF must still be a loadable PDF with one page.
  const reloaded = await PDFDocument.load(readFileSync(out))
  assert.equal(reloaded.getPageCount(), 1)
})

test('pdf_sign_stamp supports last/all pages and rejects a bad page', async () => {
  const tools = loadPlugin()
  const pdf = await makePdf(join(dir, 'multi.pdf'), 3)
  const all = await call(tools, 'pdf_sign_stamp', {
    pdf_path: pdf,
    output_path: join(dir, 'multi-all.pdf'),
    text: 'Reviewer',
    page: 'all'
  })
  assert.equal(all.placements.length, 3)

  const last = await call(tools, 'pdf_sign_stamp', {
    pdf_path: pdf,
    output_path: join(dir, 'multi-last.pdf'),
    text: 'Reviewer',
    page: 'last'
  })
  assert.equal(last.placements[0].page, 3)

  await assert.rejects(
    () => call(tools, 'pdf_sign_stamp', { pdf_path: pdf, output_path: join(dir, 'bad.pdf'), text: 'x', page: 99 }),
    /out of range/
  )
})

test('pdf_sign_stamp requires something to stamp', async () => {
  const tools = loadPlugin()
  const pdf = await makePdf(join(dir, 'empty-stamp.pdf'))
  await assert.rejects(
    () => call(tools, 'pdf_sign_stamp', { pdf_path: pdf, output_path: join(dir, 'nope.pdf') }),
    /nothing to stamp/
  )
})

test('pdf_sign_cert_generate creates a usable PKCS#12 bundle', async () => {
  const tools = loadPlugin()
  const result = await call(tools, 'pdf_sign_cert_generate', {
    common_name: 'Juntao Xiao',
    organization: 'Test Org',
    country: 'CN',
    days: 30,
    passphrase: 'test-pass-123',
    output_dir: dir,
    p12_name: 'test-cert.p12'
  })
  assert.ok(existsSync(result.p12_path), 'p12 written')
  assert.ok(result.p12_bytes > 500, `p12 has content (${result.p12_bytes} bytes)`)
  assert.match(result.subject, /CN=Juntao Xiao/)
  assert.match(result.warning, /untrusted/i)
  assert.ok(existsSync(result.key_path) && existsSync(result.cert_path))
})

test('pdf_sign_digital produces a PDF carrying a CMS signature', async () => {
  const tools = loadPlugin()
  const pdf = await makePdf(join(dir, 'to-sign.pdf'))
  const cert = await call(tools, 'pdf_sign_cert_generate', {
    common_name: 'Juntao Xiao',
    passphrase: 'test-pass-123',
    output_dir: dir,
    p12_name: 'sign-cert.p12'
  })

  const out = join(dir, 'signed.pdf')
  const result = await call(tools, 'pdf_sign_digital', {
    pdf_path: pdf,
    output_path: out,
    p12_path: cert.p12_path,
    passphrase: 'test-pass-123',
    name: 'Juntao Xiao',
    reason: 'Approval',
    location: 'Wuhan'
  })
  assert.equal(result.sub_filter, 'adbe.pkcs7.detached')
  assert.equal(result.signed_page, 1)
  assert.ok(result.bytes > 2000)

  const raw = readFileSync(out).toString('latin1')
  assert.ok(raw.includes('/ByteRange'), 'signature byte range present')
  assert.ok(raw.includes('adbe.pkcs7.detached'), 'CMS sub-filter present')
  assert.ok(raw.includes('/Reason'), 'reason metadata present')

  // Still a structurally valid PDF.
  const reloaded = await PDFDocument.load(readFileSync(out), { ignoreEncryption: true })
  assert.ok(reloaded.getPageCount() >= 1)
})

test('pdf_sign_digital rejects a wrong passphrase instead of writing junk', async () => {
  const tools = loadPlugin()
  const pdf = await makePdf(join(dir, 'wrongpass.pdf'))
  const cert = await call(tools, 'pdf_sign_cert_generate', {
    common_name: 'Wrong Pass',
    passphrase: 'correct-pass',
    output_dir: dir,
    p12_name: 'wrong-pass.p12'
  })
  await assert.rejects(() => call(tools, 'pdf_sign_digital', {
    pdf_path: pdf,
    output_path: join(dir, 'should-not-exist.pdf'),
    p12_path: cert.p12_path,
    passphrase: 'wrong-pass'
  }))
})

test('pdf_sign_digital requires an explicit certificate', async () => {
  const tools = loadPlugin()
  const pdf = await makePdf(join(dir, 'nocert.pdf'))
  await assert.rejects(
    () => call(tools, 'pdf_sign_digital', { pdf_path: pdf, output_path: join(dir, 'x.pdf') }),
    /p12_path is required/
  )
})

test('pdf_sign_inspect reports the signature it just applied', async () => {
  const tools = loadPlugin()
  const pdf = await makePdf(join(dir, 'inspect-me.pdf'))
  const cert = await call(tools, 'pdf_sign_cert_generate', {
    common_name: 'Inspector',
    passphrase: 'inspect-pass',
    output_dir: dir,
    p12_name: 'inspect.p12'
  })
  const signed = join(dir, 'inspected.pdf')
  await call(tools, 'pdf_sign_digital', {
    pdf_path: pdf,
    output_path: signed,
    p12_path: cert.p12_path,
    passphrase: 'inspect-pass',
    name: 'Inspector',
    reason: 'Verification'
  })

  const result = await call(tools, 'pdf_sign_inspect', { pdf_path: signed })
  assert.equal(result.has_signature, true)
  assert.ok(result.byte_range_count >= 1)
  assert.ok(result.sub_filters.includes('adbe.pkcs7.detached'))
  assert.equal(result.metadata.Reason, 'Verification')

  const unsigned = await call(tools, 'pdf_sign_inspect', { pdf_path: pdf })
  assert.equal(unsigned.has_signature, false)
})

test('pdf_sign_stamp draws CJK text by embedding a Unicode font', async () => {
  const tools = loadPlugin()
  const pdf = await makePdf(join(dir, 'cjk.pdf'))
  const out = join(dir, 'cjk-signed.pdf')
  const result = await call(tools, 'pdf_sign_stamp', {
    pdf_path: pdf,
    output_path: out,
    text: '肖俊涛',
    date_text: '2026年9月20日',
    reason: '合同审批通过',
    anchor: 'bottom-right'
  })
  assert.equal(result.stamped_text, true)
  assert.equal(result.text_font_embedded, true, 'CJK text must embed a real font, not WinAnsi Helvetica')
  assert.ok(result.bytes > 2000)
  assert.ok(existsSync(out))
  const reloaded = await PDFDocument.load(readFileSync(out))
  assert.equal(reloaded.getPageCount(), 1)
})

test('pdf_sign_stamp keeps Latin-only text on a standard font', async () => {
  const tools = loadPlugin()
  const pdf = await makePdf(join(dir, 'latin.pdf'))
  const result = await call(tools, 'pdf_sign_stamp', {
    pdf_path: pdf,
    output_path: join(dir, 'latin-signed.pdf'),
    text: 'Juntao Xiao',
    date_text: '2026-09-20'
  })
  assert.equal(result.text_font_embedded, false, 'Latin-1 text needs no embedded font')
})

test('default output paths sit beside the source with a suffix', async () => {
  const tools = loadPlugin()
  const pdf = await makePdf(join(dir, 'defaults.pdf'))
  const result = await call(tools, 'pdf_sign_stamp', { pdf_path: pdf, text: 'Namer' })
  assert.match(result.path, /defaults-signed\.pdf$/)
  assert.ok(existsSync(result.path))
})

test('defaultOutputDir config redirects generated output', async () => {
  const outDir = mkdtempSync(join(tmpdir(), 'dsh-pdf-sign-out-'))
  const tools = loadPlugin({ defaultOutputDir: outDir })
  const pdf = await makePdf(join(dir, 'cfg.pdf'))
  const result = await call(tools, 'pdf_sign_stamp', { pdf_path: pdf, text: 'Namer' })
  assert.ok(result.path.startsWith(outDir), `output landed in the configured dir: ${result.path}`)
})

// ---------------------------------------------------------------- background keying

/**
 * Build an OPAQUE PNG: a solid light background with an inset dark band.
 *
 * The band is inset on all four sides on purpose — it leaves the border ring a
 * clean sample of the background (so `auto` detection is exercised honestly) and
 * makes the trim assertion meaningful on width as well as height.
 */
async function makeOpaqueArtwork(path, { width = 80, height = 50, bg = [255, 255, 255] } = {}) {
  const rgba = Buffer.alloc(width * height * 4)
  const x0 = Math.floor(width * 0.2)
  const x1 = Math.floor(width * 0.8)
  const y0 = Math.floor(height * 0.45)
  const y1 = Math.floor(height * 0.55)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const onBand = x >= x0 && x < x1 && y >= y0 && y < y1
      const c = onBand ? [20, 20, 20] : bg
      rgba[i] = c[0]; rgba[i + 1] = c[1]; rgba[i + 2] = c[2]; rgba[i + 3] = 255
    }
  }
  writeFileSync(path, encodeRgbaPng(width, height, rgba))
  return path
}

/** Count image XObjects on a page that carry an /SMask (i.e. real transparency). */
async function countSmasks(pdfPath) {
  const doc = await PDFDocument.load(readFileSync(pdfPath), { ignoreEncryption: true, updateMetadata: false })
  let withSmasks = 0
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    const d = obj?.dict
    if (d?.get?.(PDFName.of('Subtype'))?.toString() !== '/Image') continue
    if (d.get(PDFName.of('SMask')) !== undefined) withSmasks++
  }
  return withSmasks
}

test('an opaque white-background image warns that it will cover what is beneath it', async () => {
  const tools = loadPlugin()
  const pdf = await makePdf(join(dir, 'warn.pdf'))
  const art = await makeOpaqueArtwork(join(dir, 'opaque-warn.png'))
  const result = await call(tools, 'pdf_sign_stamp', {
    pdf_path: pdf,
    output_path: join(dir, 'warn-signed.pdf'),
    image_path: art
  })
  assert.equal(result.image.background_removed, false)
  assert.match(result.note, /fully opaque/i, 'warning explains the opaque background')
  assert.match(result.note, /drop_background/i, 'warning names the parameter to fix it')
  assert.equal(await countSmasks(result.path), 0, 'nothing was keyed, so no transparency')
})

test('drop_background "white" keys the background out and writes real transparency', async () => {
  const tools = loadPlugin()
  const pdf = await makePdf(join(dir, 'key.pdf'))
  const art = await makeOpaqueArtwork(join(dir, 'opaque-key.png'))
  const result = await call(tools, 'pdf_sign_stamp', {
    pdf_path: pdf,
    output_path: join(dir, 'key-signed.pdf'),
    image_path: art,
    drop_background: 'white'
  })
  assert.equal(result.image.background_removed, true)
  assert.deepEqual(result.image.background_color, [255, 255, 255])
  assert.ok(result.image.transparent_pixels > 0, `transparent pixels: ${result.image.transparent_pixels}`)
  // The proof that matters: the PDF carries an /SMask, so the stamp cannot white-out the page.
  assert.equal(await countSmasks(result.path), 1, 'embedded image has an /SMask')
})

test('drop_background "auto" samples the image border colour', async () => {
  const tools = loadPlugin()
  const pdf = await makePdf(join(dir, 'auto.pdf'))
  const art = await makeOpaqueArtwork(join(dir, 'opaque-auto.png'), { bg: [250, 248, 245] })
  const result = await call(tools, 'pdf_sign_stamp', {
    pdf_path: pdf,
    output_path: join(dir, 'auto-signed.pdf'),
    image_path: art,
    drop_background: 'auto'
  })
  assert.equal(result.image.background_removed, true)
  const [r, g, b] = result.image.background_color
  assert.ok(Math.abs(r - 250) <= 3 && Math.abs(g - 248) <= 3 && Math.abs(b - 245) <= 3,
    `detected near the real background, got rgb(${r},${g},${b})`)
  assert.ok(result.image.background_coverage > 0.5, `border coverage ${result.image.background_coverage}`)
  assert.equal(await countSmasks(result.path), 1)
})

test('trim_image crops the transparent margins so ink defines the box', async () => {
  const tools = loadPlugin()
  const pdf = await makePdf(join(dir, 'trim.pdf'))
  const art = await makeOpaqueArtwork(join(dir, 'opaque-trim.png'), { width: 200, height: 120 })
  const kept = await call(tools, 'pdf_sign_stamp', {
    pdf_path: pdf,
    output_path: join(dir, 'trim-kept.pdf'),
    image_path: art,
    drop_background: 'white',
    trim_image: false
  })
  const cropped = await call(tools, 'pdf_sign_stamp', {
    pdf_path: pdf,
    output_path: join(dir, 'trim-cropped.pdf'),
    image_path: art,
    drop_background: 'white',
    trim_image: true
  })
  assert.equal(kept.image.trimmed, false)
  assert.equal(kept.image.source_width, 200)
  assert.equal(kept.image.source_height, 120)
  // With trimming off, what gets embedded is the source canvas.
  assert.equal(kept.image.width, 200)
  assert.equal(kept.image.height, 120)

  assert.equal(cropped.image.trimmed, true)
  // Source dimensions are reported unchanged; the embedded size is what shrank.
  assert.equal(cropped.image.source_width, 200, 'source size is reported as-is')
  assert.equal(cropped.image.source_height, 120, 'source size is reported as-is')
  assert.ok(cropped.image.height < 40, `embedded height ${cropped.image.height} of 120`)
  assert.ok(cropped.image.width < 200, `embedded width ${cropped.image.width} of 200`)
})

test('drop_background also works on a JPEG source', async () => {
  // Build a JPEG through jpeg-js so the JPEG path is genuinely exercised.
  const jpeg = (await import('jpeg-js')).default
  const width = 60, height = 40
  const data = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const ink = x > 20 && x < 40 && y > 12 && y < 28
      const v = ink ? 15 : 255
      data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255
    }
  }
  const art = join(dir, 'opaque.jpg')
  writeFileSync(art, jpeg.encode({ data, width, height }, 92).data)

  const tools = loadPlugin()
  const pdf = await makePdf(join(dir, 'jpg.pdf'))
  const result = await call(tools, 'pdf_sign_stamp', {
    pdf_path: pdf,
    output_path: join(dir, 'jpg-signed.pdf'),
    image_path: art,
    drop_background: 'white'
  })
  assert.equal(result.image.background_removed, true)
  assert.equal(await countSmasks(result.path), 1, 'JPEG source still yields a transparent stamp')
})

test('drop_background rejects an unparseable colour', async () => {
  const tools = loadPlugin()
  const pdf = await makePdf(join(dir, 'badcolor.pdf'))
  const art = await makeOpaqueArtwork(join(dir, 'opaque-badcolor.png'))
  await assert.rejects(() => call(tools, 'pdf_sign_stamp', {
    pdf_path: pdf,
    output_path: join(dir, 'badcolor-signed.pdf'),
    image_path: art,
    drop_background: 'not-a-colour'
  }), /cannot parse colour/)
})
