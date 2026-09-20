/**
 * dsh-pdf-sign — PDF electronic signing for DeepSeek Harness.
 *
 * Three capabilities, deliberately separate because they mean different things:
 *   1. `pdf_signature_image`  — generate a handwritten-style signature image.
 *   2. `pdf_sign_stamp`       — place a signature image / typed block on a PDF
 *                               (a VISUAL signature: ink on the page).
 *   3. `pdf_sign_digital`     — apply a real PKCS#7 cryptographic signature
 *                               using a PKCS#12 certificate you supply.
 *
 * Plus `pdf_sign_cert_generate` (self-signed certificate for testing) and
 * `pdf_sign_inspect` (report what signatures a PDF structurally contains).
 *
 * This plugin ships no keys, no CA and no trust anchor, and declares no
 * `@deepseek-ai` runtime imports: `defineTool` is reproduced locally against the
 * documented tool shape so the plugin loads even in a minimal composition.
 * @module dsh-pdf-sign
 */
import { PDFDocument } from 'pdf-lib'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { generateSignatureImage, INK_COLORS } from './signature.js'
import { stampSignature, ANCHORS } from './stamp.js'
import {
  SUBFILTERS,
  bundleP12,
  generateSelfSignedCertificate,
  inspectPdfSignatures,
  signPdfDigital
} from './digital.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'pdf-sign'

/** Only the tool registry is required. */
export const inject = ['tools']

/**
 * Local equivalent of `@deepseek-ai/dsh-tools`'s `defineTool`.
 *
 * The registered shape is the post-`defineTool` shape, so parameters are
 * authored as JSON Schema directly (the host's `defineTool` would convert a
 * schema spec into exactly this). Avoids a runtime dependency on the host's
 * tool package.
 * @param options - tool definition.
 * @returns the definition the tool registry expects.
 */
function defineTool(options) {
  return {
    name: options.name,
    description: options.description,
    parameters: options.parameters,
    output: {
      schema: options.output?.schema ?? { type: 'object', additionalProperties: true },
      render: options.output?.render ?? ((_args, value) => value),
      ...(options.output?.presentationMeta !== undefined
        ? { presentationMeta: options.output.presentationMeta }
        : {})
    },
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.isConcurrencySafe !== undefined ? { isConcurrencySafe: options.isConcurrencySafe } : {}),
    async execute(args, exec) {
      return options.execute(args, exec)
    }
  }
}

/**
 * Output schemas list their properties for documentation but declare nothing
 * `required` (and allow additional properties), so a definition can never fail
 * the runtime output validation just because a field is absent in an edge case.
 */
const OUTPUT = (properties) => ({
  type: 'object',
  properties,
  additionalProperties: true
})

/** Resolve a user-supplied path to absolute form. */
function absolutize(filePath) {
  return resolve(filePath)
}

/**
 * Read a required string argument, failing with the tool's own message rather
 * than a downstream `path must be a string` TypeError.
 * @param args - the tool arguments.
 * @param key - the argument name.
 * @param why - what the argument is for, appended to the error.
 * @returns the argument value.
 */
function requirePath(args, key, why) {
  const value = args[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${key} is required${why === undefined ? '' : ` — ${why}`}`)
  }
  return value
}

/** Default output beside the input: `contract.pdf` + `-signed` + `.pdf`. */
function signedSibling(filePath, suffix, extension) {
  const absolute = absolutize(filePath)
  const match = /^(.*?)(\.[^./\\]+)?$/.exec(absolute)
  const stem = match?.[1] ?? absolute
  const ext = match?.[2] ?? extension ?? ''
  return `${stem}${suffix}${ext}`
}

/**
 * Register the PDF signing tool suite.
 * @param ctx - Cordis context providing `ctx.tools`.
 * @param config - optional row config (`defaultFontFile`, `defaultOutputDir`).
 */
export function apply(ctx, config = {}) {
  const defaultFontFile = typeof config.defaultFontFile === 'string' ? config.defaultFontFile : undefined
  const defaultOutputDir = typeof config.defaultOutputDir === 'string' ? config.defaultOutputDir : undefined
  const outputIn = (filePath, suffix, extension) => {
    const sibling = signedSibling(filePath, suffix, extension)
    if (defaultOutputDir === undefined) return sibling
    const base = sibling.replace(/^.*[\\/]/, '')
    return resolve(defaultOutputDir, base)
  }

  ctx.tools.register(defineTool({
    name: 'pdf_signature_image',
    description:
      'Generate a handwritten-style signature image (PNG, or SVG when the optional native rasterizer is ' +
      'unavailable) from a name or any text. Each glyph is individually rotated and jittered with a ' +
      'text-seeded pattern, so the same name always produces the same signature.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The signature text — usually the signer name.' },
        output_path: { type: 'string', description: 'Absolute path to write. Extension .png (default) or .svg.' },
        font_size: { type: 'number', description: 'Glyph size in pixels. Default 120.' },
        width: { type: 'number', description: 'Output PNG width in pixels. Defaults to the SVG intrinsic width.' },
        color: {
          type: 'string',
          description: `Ink colour: ${Object.keys(INK_COLORS).join(', ')}, a #rrggbb hex, or an "r,g,b" triple with 0-1 components.`
        },
        rotation: { type: 'number', description: 'Whole-signature rotation in degrees. Default -2.5 (a slight natural tilt).' },
        jitter: { type: 'number', description: 'Handwriting irregularity, 0 = perfectly straight glyphs. Default 1.' },
        underline: { type: 'boolean', description: 'Draw a pen flourish under the signature. Default true.' },
        letter_spacing: { type: 'number', description: 'Extra spacing between glyphs in pixels.' },
        font_file: { type: 'string', description: 'Explicit font file path; defaults to the best handwriting font found on this system.' },
        format: { type: 'string', enum: ['png', 'svg'], description: 'Force an output format. Default png.' }
      },
      required: ['text', 'output_path'],
      additionalProperties: false
    },
    output: OUTPUT({
      path: { type: 'string' },
      format: { type: 'string' },
      width: { type: 'number' },
      height: { type: 'number' },
      bytes: { type: 'number' },
      font_path: { type: 'string' },
      rasterized: { type: 'boolean' },
      note: { type: 'string' }
    }),
    isConcurrencySafe: () => true,
    async execute(args) {
      const result = await generateSignatureImage({
        text: args.text,
        outputPath: absolutize(requirePath(args, 'output_path', 'where to write the signature image')),
        fontSize: args.font_size,
        width: args.width,
        color: normalizeColor(args.color),
        rotate: args.rotation,
        jitter: args.jitter,
        underline: args.underline,
        letterSpacing: args.letter_spacing,
        fontFile: args.font_file ?? defaultFontFile,
        format: args.format
      })
      return {
        path: result.path,
        format: result.format,
        width: result.width,
        height: result.height,
        bytes: result.bytes,
        font_path: result.fontPath ?? undefined,
        rasterized: result.rasterized,
        note: result.note
      }
    }
  }))

  ctx.tools.register(defineTool({
    name: 'pdf_sign_stamp',    description:
      'Place a signature on a PDF: a signature image, a typed signature block (name / date / reason), or both. ' +
      'This is a VISUAL signature — it puts ink on the page and gives no cryptographic guarantee. ' +
      'Use pdf_sign_digital for a verifiable signature.',
    parameters: {
      type: 'object',
      properties: {
        pdf_path: { type: 'string', description: 'Source PDF path.' },
        output_path: { type: 'string', description: 'Where to write the stamped PDF. Defaults to "<name>-signed.pdf" beside the source.' },
        image_path: { type: 'string', description: 'Signature image (PNG/JPEG) to place.' },
        text: { type: 'string', description: 'Typed signer name.' },
        date_text: { type: 'string', description: 'Date line, e.g. "2026-09-20".' },
        reason: { type: 'string', description: 'Reason or note line.' },
        page: {
          description: 'Page to stamp: a 1-based number, "last" (default), or "all".',
          oneOf: [{ type: 'number' }, { type: 'string' }]
        },
        anchor: { type: 'string', enum: ANCHORS, description: 'Placement anchor. Default bottom-right.' },
        x: { type: 'number', description: 'Explicit x in PDF points; overrides anchor.' },
        y: { type: 'number', description: 'Explicit y in PDF points; overrides anchor.' },
        width: { type: 'number', description: 'Signature image width in PDF points. Default 180.' },
        opacity: { type: 'number', description: 'Ink opacity 0-1. Default 1.' },
        rotation: { type: 'number', description: 'Image rotation in degrees.' },
        margin: { type: 'number', description: 'Margin from the page edge in points. Default 48.' },
        font_size: { type: 'number', description: 'Text block font size. Default 10.' },
        color: { type: 'string', description: 'Text colour: #rrggbb or "r,g,b" with 0-1 components.' },
        drop_background: {
          type: 'string',
          description:
            'Key a flat light background out to transparency before stamping: "none" (default), "white", ' +
            '"auto" (sample the image border), or an explicit "#rrggbb". Needed whenever the image is an ' +
            'opaque white-background export — otherwise its background rectangle covers what it is drawn over, ' +
            'so a seal drawn over a signature erases the signature.'
        },
        drop_tolerance: {
          type: 'number',
          description: 'Per-channel tolerance (0-255) for treating a pixel as background. Default 28.'
        },
        trim_image: {
          type: 'boolean',
          description:
            'Crop transparent margins so the image’s real ink defines the placement box. Default true; ' +
            'set false to keep the source canvas.'
        }
      },
      required: ['pdf_path'],
      additionalProperties: false
    },
    output: OUTPUT({
      path: { type: 'string' },
      bytes: { type: 'number' },
      page_count: { type: 'number' },
      placements: { type: 'array', items: { type: 'object', additionalProperties: true } },
      stamped_image: { type: 'boolean' },
      stamped_text: { type: 'boolean' },
      text_font_embedded: { type: 'boolean' },
      image: {
        type: 'object',
        properties: {
          source_width: { type: 'number' },
          source_height: { type: 'number' },
          background_removed: { type: 'boolean' },
          background_color: { type: 'array', items: { type: 'number' } },
          background_coverage: { type: 'number' },
          transparent_pixels: { type: 'number' },
          trimmed: { type: 'boolean' },
          trim_box: { type: 'object', additionalProperties: true }
        },
        additionalProperties: true
      },
      note: { type: 'string' }
    }),
    async execute(args) {
      const pdfPath = absolutize(requirePath(args, 'pdf_path', 'the PDF to stamp'))
      if (!existsSync(pdfPath)) throw new Error(`PDF not found: ${pdfPath}`)
      const outputPath = args.output_path !== undefined
        ? absolutize(args.output_path)
        : outputIn(pdfPath, '-signed', '.pdf')
      const result = await stampSignature({
        pdfPath,
        outputPath,
        imagePath: args.image_path !== undefined ? absolutize(args.image_path) : undefined,
        text: args.text,
        dateText: args.date_text,
        reason: args.reason,
        pages: args.page,
        anchor: args.anchor,
        x: args.x,
        y: args.y,
        width: args.width,
        opacity: args.opacity,
        rotation: args.rotation,
        margin: args.margin,
        fontSize: args.font_size,
        color: normalizeColor(args.color),
        dropBackground: args.drop_background,
        dropTolerance: args.drop_tolerance,
        trimImage: args.trim_image
      })
      return {
        path: result.path,
        bytes: result.bytes,
        page_count: result.pageCount,
        placements: result.placements,
        stamped_image: result.stampedImage,
        stamped_text: result.stampedText,
        text_font_embedded: result.textFontEmbedded,
        image: result.image === undefined
          ? undefined
          : {
              source_width: result.image.sourceWidth,
              source_height: result.image.sourceHeight,
              background_removed: result.image.backgroundRemoved,
              background_color: result.image.backgroundColor,
              background_coverage: result.image.backgroundCoverage,
              transparent_pixels: result.image.transparentPixels,
              trimmed: result.image.trimmed,
              trim_box: result.image.trimBox
            },
        note: result.note
      }
    }
  }))

  ctx.tools.register(defineTool({
    name: 'pdf_sign_digital',
    description:
      'Apply a real PKCS#7/CMS detached signature to a PDF using a PKCS#12 (.p12/.pfx) certificate you supply. ' +
      'Produces a signature PDF readers can validate as intact. Trust depends on the certificate: a self-signed ' +
      'one shows as untrusted. This plugin ships no keys and no CA.',
    parameters: {
      type: 'object',
      properties: {
        pdf_path: { type: 'string', description: 'Source PDF path.' },
        output_path: { type: 'string', description: 'Where to write the signed PDF. Defaults to "<name>-digitally-signed.pdf".' },
        p12_path: { type: 'string', description: 'Your PKCS#12 (.p12/.pfx) certificate bundle containing the private key.' },
        passphrase: { type: 'string', description: 'Passphrase for the PKCS#12 file. Empty string when unprotected.' },
        name: { type: 'string', description: 'Signer name recorded in the signature.' },
        reason: { type: 'string', description: 'Reason recorded in the signature. Default "Approved".' },
        location: { type: 'string', description: 'Location recorded in the signature.' },
        contact_info: { type: 'string', description: 'Contact information recorded in the signature.' },
        signing_time: { type: 'string', description: 'ISO timestamp to record. Defaults to now.' },
        page: {
          description: 'Page the signature widget sits on: 1-based number or "last" (default).',
          oneOf: [{ type: 'number' }, { type: 'string' }]
        },
        widget_rect: {
          type: 'array',
          items: { type: 'number' },
          description: '[x1, y1, x2, y2] rectangle for the signature widget in PDF points.'
        },
        sub_filter: { type: 'string', enum: Object.keys(SUBFILTERS), description: 'CMS sub-filter. Default adbe.pkcs7.detached.' },
        signature_length: { type: 'number', description: 'Reserved placeholder size in bytes. Raise it if signing fails with a length error.' }
      },
      required: ['pdf_path', 'p12_path'],
      additionalProperties: false
    },
    output: OUTPUT({
      path: { type: 'string' },
      bytes: { type: 'number' },
      page_count: { type: 'number' },
      signed_page: { type: 'number' },
      sub_filter: { type: 'string' },
      identity: { type: 'object', additionalProperties: true },
      warning: { type: 'string' }
    }),
    async execute(args) {
      const pdfPath = absolutize(requirePath(args, 'pdf_path', 'the PDF to sign'))
      const p12Path = absolutize(requirePath(
        args,
        'p12_path',
        'supply your own .p12/.pfx; pdf_sign_cert_generate can create a self-signed one for testing'
      ))
      const outputPath = args.output_path !== undefined
        ? absolutize(args.output_path)
        : outputIn(pdfPath, '-digitally-signed', '.pdf')
      const result = await signPdfDigital({
        pdfPath,
        outputPath,
        p12Path,
        passphrase: args.passphrase,
        name: args.name,
        reason: args.reason,
        location: args.location,
        contactInfo: args.contact_info,
        signingTime: args.signing_time,
        page: args.page,
        widgetRect: args.widget_rect,
        subFilter: args.sub_filter,
        signatureLength: args.signature_length
      })
      return {
        path: result.path,
        bytes: result.bytes,
        page_count: result.pageCount,
        signed_page: result.signedPage,
        sub_filter: result.subFilter,
        identity: result.identity,
        warning: result.warning
      }
    }
  }))

  ctx.tools.register(defineTool({
    name: 'pdf_sign_cert_generate',
    description:
      'Create a self-signed certificate and PKCS#12 bundle for signing, or bundle an existing key + certificate ' +
      'pair into a .p12. Self-signed output is for testing and internal use: readers validate it as intact but ' +
      'untrusted. Requires OpenSSL on the machine.',
    parameters: {
      type: 'object',
      properties: {
        common_name: { type: 'string', description: 'Name the certificate identifies (required unless bundling an existing pair).' },
        output_dir: { type: 'string', description: 'Directory for the generated files. Defaults to the process working directory.' },
        organization: { type: 'string', description: 'Organization (O) field. Default "Self-Signed".' },
        country: { type: 'string', description: 'Two-letter country (C) field. Default "CN".' },
        days: { type: 'number', description: 'Validity in days. Default 365.' },
        passphrase: { type: 'string', description: 'Passphrase to protect the PKCS#12. At least 4 characters.' },
        key_path: { type: 'string', description: 'Existing private key to bundle instead of generating a new one.' },
        cert_path: { type: 'string', description: 'Existing certificate to bundle instead of generating a new one.' },
        p12_name: { type: 'string', description: 'Output .p12 filename. Default "signing-cert.p12".' }
      },
      required: ['passphrase'],
      additionalProperties: false
    },
    output: OUTPUT({
      p12_path: { type: 'string' },
      key_path: { type: 'string' },
      cert_path: { type: 'string' },
      p12_bytes: { type: 'number' },
      subject: { type: 'string' },
      days: { type: 'number' },
      warning: { type: 'string' }
    }),
    async execute(args) {
      if (args.key_path !== undefined && args.cert_path !== undefined) {
        const p12Path = resolve(
          args.output_dir !== undefined ? absolutize(args.output_dir) : process.cwd(),
          args.p12_name ?? 'signing-cert.p12'
        )
        const bundled = bundleP12({
          keyPath: absolutize(args.key_path),
          certPath: absolutize(args.cert_path),
          p12Path,
          passphrase: args.passphrase,
          alias: args.common_name ?? 'signing'
        })
        return {
          p12_path: bundled.p12Path,
          p12_bytes: bundled.p12Bytes,
          warning: 'Bundled an existing key and certificate. Trust depends on that certificate\'s issuer.'
        }
      }
      if (args.common_name === undefined || String(args.common_name).trim() === '') {
        throw new Error('common_name is required (or provide both key_path and cert_path to bundle an existing pair)')
      }
      const result = generateSelfSignedCertificate({
        outputDir: args.output_dir !== undefined ? absolutize(args.output_dir) : process.cwd(),
        commonName: args.common_name,
        organization: args.organization,
        country: args.country,
        days: args.days,
        passphrase: args.passphrase,
        p12Name: args.p12_name ?? 'signing-cert.p12'
      })
      return {
        p12_path: result.p12Path,
        key_path: result.keyPath,
        cert_path: result.certPath,
        p12_bytes: result.p12Bytes,
        subject: result.subject,
        days: result.days,
        warning: result.warning
      }
    }
  }))

  ctx.tools.register(defineTool({
    name: 'pdf_sign_inspect',
    description:
      'Inspect a PDF for signatures: signature form fields, how many byte ranges are signed, the CMS sub-filter, ' +
      'and the metadata recorded in the signature. Structural inspection only — it does not verify cryptographic ' +
      'validity, which needs the signer\'s certificate chain.',
    parameters: {
      type: 'object',
      properties: {
        pdf_path: { type: 'string', description: 'PDF to inspect.' }
      },
      required: ['pdf_path'],
      additionalProperties: false
    },
    output: OUTPUT({
      path: { type: 'string' },
      bytes: { type: 'number' },
      page_count: { type: 'number' },
      form_fields: { type: 'array', items: { type: 'object', additionalProperties: true } },
      signature_field_count: { type: 'number' },
      byte_range_count: { type: 'number' },
      sub_filters: { type: 'array', items: { type: 'string' } },
      metadata: { type: 'object', additionalProperties: true },
      has_signature: { type: 'boolean' },
      note: { type: 'string' }
    }),
    isConcurrencySafe: () => true,
    async execute(args) {
      const result = await inspectPdfSignatures(absolutize(args.pdf_path))
      return {
        path: result.path,
        bytes: result.bytes,
        page_count: result.pageCount,
        form_fields: result.formFields,
        signature_field_count: result.signatureFieldCount,
        byte_range_count: result.byteRangeCount,
        sub_filters: result.subFilters,
        metadata: result.metadata,
        has_signature: result.hasSignature,
        note: result.note
      }
    }
  }))
}

/** Accept a preset name, #rrggbb, or an "r,g,b" triple; return what pdf-lib wants. */
function normalizeColor(input) {
  if (input === undefined) return undefined
  if (input in INK_COLORS) return INK_COLORS[input]
  const parts = String(input).split(',').map((s) => Number(s.trim()))
  if (parts.length === 3 && parts.every((n) => Number.isFinite(n) && n >= 0 && n <= 1)) return parts
  return input
}

export { PDFDocument }
