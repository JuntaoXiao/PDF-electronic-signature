/**
 * Type declarations for dsh-pdf-sign.
 *
 * The runtime entry is plain ESM (`lib/index.js`); these declarations describe
 * the Cordis plugin surface plus the exported helpers.
 */

/** A JSON Schema object as accepted by the tool registry. */
export type JsonSchema = Record<string, unknown>

/** A registered tool, in the shape the DSH tool registry expects. */
export interface ToolDefinition {
  name: string
  description: string
  parameters: JsonSchema
  output: {
    schema: JsonSchema
    render: (args: Record<string, unknown>, value: unknown) => unknown
    presentationMeta?: (args: Record<string, unknown>, value: unknown) => unknown
  }
  timeoutMs?: number
  isConcurrencySafe?: () => boolean
  execute: (args: Record<string, unknown>, exec?: unknown) => Promise<unknown>
}

/** Services this plugin requires from the host. */
export declare const inject: string[]

/** Cordis plugin name used by loader diagnostics. */
export declare const name: string

/** Optional row config. */
export interface PdfSignConfig {
  /** Default font file for signature image generation. */
  defaultFontFile?: string
  /** Directory that generated outputs are redirected into. */
  defaultOutputDir?: string
}

/** Register the PDF signing tool suite. */
export declare function apply(ctx: { tools: { register(tool: ToolDefinition): unknown } }, config?: PdfSignConfig): void

/** Ink presets accepted by the `color` argument. */
export declare const INK_COLORS: Record<string, string>

/** Nine placement anchors accepted by the `anchor` argument. */
export declare const ANCHORS: string[]

/** Supported CMS sub-filters. */
export declare const SUBFILTERS: Record<string, string>

export interface SignatureImageResult {
  path: string
  format: 'png' | 'svg'
  width: number
  height: number
  bytes: number
  fontPath: string | null
  rasterized: boolean
  svgFallbackPath: string | null
  note?: string
}

export interface SignatureImageOptions {
  text: string
  outputPath: string
  fontSize?: number
  width?: number
  color?: string
  rotate?: number
  jitter?: number
  underline?: boolean
  letterSpacing?: number
  fontFile?: string
  format?: 'png' | 'svg'
}

/** Build a handwritten-style signature SVG without writing anything. */
export declare function buildSignatureSvg(options: SignatureImageOptions & { fontFamily?: string; padding?: number }): {
  svg: string
  width: number
  height: number
}

/** Generate a signature image on disk, falling back to SVG when PNG is unavailable. */
export declare function generateSignatureImage(options: SignatureImageOptions): Promise<SignatureImageResult>

/** Locate a usable font file. */
export declare function resolveFont(explicit?: string): { path: string; family: string } | undefined

export interface Placement {
  page: number
  x: number
  y: number
  width: number
  height: number
  pageWidth: number
}

export interface StampOptions {
  pdfPath: string
  outputPath: string
  imagePath?: string
  text?: string
  dateText?: string
  reason?: string
  pages?: number | string | Array<number | string>
  anchor?: string
  x?: number
  y?: number
  width?: number
  opacity?: number
  rotation?: number
  margin?: number
  fontSize?: number
  color?: string | number[]
}

/** Place a signature image and/or typed block onto PDF pages (visual signature). */
export declare function stampSignature(options: StampOptions): Promise<{
  path: string
  bytes: number
  pageCount: number
  placements: Placement[]
  stampedImage: boolean
  stampedText: boolean
  textFontEmbedded: boolean
  textFontPath: string | null
  note: string
}>

export interface DigitalSignOptions {
  pdfPath: string
  outputPath: string
  p12Path: string
  passphrase?: string
  reason?: string
  name?: string
  location?: string
  contactInfo?: string
  signingTime?: string | Date
  subFilter?: string
  signatureLength?: number
  widgetRect?: number[]
  page?: number | string
}

/** Apply a PKCS#7/CMS detached signature using the supplied PKCS#12 certificate. */
export declare function signPdfDigital(options: DigitalSignOptions): Promise<{
  path: string
  bytes: number
  pageCount: number
  signedPage: number
  subFilter: string
  identity: { name: string; reason: string; location: string }
  integrity: string
  warning: string
}>

export interface CertGenerateOptions {
  outputDir?: string
  commonName: string
  organization?: string
  country?: string
  days?: number
  passphrase: string
  keyName?: string
  certName?: string
  p12Name?: string
  keyUsage?: string
  extendedKeyUsage?: string
}

/** Create a self-signed certificate and PKCS#12 bundle. */
export declare function generateSelfSignedCertificate(options: CertGenerateOptions): {
  keyPath: string
  certPath: string
  p12Path: string
  p12Bytes: number
  subject: string
  days: number
  openssl: string
  warning: string
}

/** Bundle an existing key + certificate pair into a PKCS#12 file. */
export declare function bundleP12(options: {
  keyPath: string
  certPath: string
  p12Path: string
  passphrase: string
  alias?: string
}): { p12Path: string; p12Bytes: number }

/** Locate a runnable openssl executable. */
export declare function resolveOpenssl(): string

/** Structurally inspect a PDF for signatures (no cryptographic verification). */
export declare function inspectPdfSignatures(pdfPath: string): Promise<{
  path: string
  bytes: number
  pageCount: number
  formFields: Array<{ name: string; type: string }>
  signatureFieldCount: number
  byteRangeCount: number
  subFilters: string[]
  metadata: Record<string, string>
  hasSignature: boolean
  note: string
}>
