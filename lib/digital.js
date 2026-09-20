/**
 * Cryptographic PDF signing: PKCS#7/CMS detached signatures with a PKCS#12
 * certificate the user supplies, plus a self-signed certificate generator for
 * testing.
 *
 * Security stance — this module deliberately ships **no** keys, **no** CA, and
 * **no** trust anchor. A signature is only as meaningful as the certificate
 * behind it: a self-signed certificate produces a technically valid signature
 * that no reader will show as trusted. Obtaining a certificate from a real CA
 * is the user's job.
 * @module dsh-pdf-sign/digital
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { PDFDocument } from 'pdf-lib'

/** Sub-filters a PDF reader understands for embedded CMS signatures. */
export const SUBFILTERS = {
  'adbe.pkcs7.detached': 'adbe.pkcs7.detached',
  'ETSI.CAdES.detached': 'ETSI.CAdES.detached'
}

/** Absolute candidates for a usable openssl, tried when the PATH lookup fails. */
const OPENSSL_CANDIDATES = [
  process.env.OPENSSL_PATH,
  'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
  'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe',
  'C:\\Program Files\\OpenSSL-Win64\\bin\\openssl.exe',
  '/usr/bin/openssl',
  '/usr/local/bin/openssl',
  '/opt/homebrew/bin/openssl'
].filter((value) => typeof value === 'string' && value.length > 0)

/**
 * Find a runnable openssl. An explicit override wins; otherwise try the PATH
 * first and then the known absolute locations.
 * @returns the executable to invoke.
 * @throws when no working openssl is found.
 */
export function resolveOpenssl() {
  const attempts = [...OPENSSL_CANDIDATES]
  // Bare name resolves through PATH.
  attempts.splice(attempts.indexOf(process.env.OPENSSL_PATH ?? '__none__') + 1, 0, 'openssl')
  const tried = []
  for (const candidate of attempts) {
    if (candidate === undefined || candidate === null || candidate === '') continue
    if (candidate !== 'openssl' && !existsSync(candidate)) {
      tried.push(candidate)
      continue
    }
    try {
      execFileSync(candidate, ['version'], { stdio: 'pipe' })
      return candidate
    } catch {
      tried.push(candidate)
    }
  }
  throw new Error(
    'openssl not found; certificate generation needs it. Install OpenSSL, or set OPENSSL_PATH. ' +
    `Tried: ${tried.join(', ') || '(none)'}`
  )
}

/** Escape a value for openssl's `-subj` slash-delimited syntax. */
function escapeSubjPart(value) {
  return String(value).replace(/([\\/=+])/g, '\\$1').replace(/^\s+|\s+$/g, '')
}

/**
 * Generate a self-signed certificate and PKCS#12 bundle for signing.
 *
 * The result proves integrity and signer identity to the same degree a
 * self-signed certificate can — which is: the document was not altered after
 * signing, and it was signed by whoever holds this key. Readers will label it
 * untrusted because no CA vouches for it.
 * @param options - subject fields, validity and output locations.
 * @returns the written file paths and the certificate subject.
 */
export function generateSelfSignedCertificate(options) {
  const {
    outputDir,
    commonName,
    organization = 'Self-Signed',
    country = 'CN',
    days = 365,
    passphrase,
    keyName = 'signing-key.pem',
    certName = 'signing-cert.pem',
    p12Name = 'signing-cert.p12',
    keyUsage = 'digitalSignature,nonRepudiation',
    extendedKeyUsage = 'emailProtection'
  } = options

  if (typeof commonName !== 'string' || commonName.trim() === '') {
    throw new Error('commonName is required (the name the certificate identifies)')
  }
  if (typeof passphrase !== 'string' || passphrase.length < 4) {
    throw new Error('passphrase is required and must be at least 4 characters')
  }
  const dir = outputDir ?? process.cwd()
  const keyPath = resolve(dir, keyName)
  const certPath = resolve(dir, certName)
  const p12Path = resolve(dir, p12Name)
  const openssl = resolveOpenssl()

  const subject =
    `/CN=${escapeSubjPart(commonName)}` +
    `/O=${escapeSubjPart(organization)}` +
    `/C=${escapeSubjPart(country)}`

  const args = [
    'req', '-x509', '-newkey', 'rsa:2048',
    '-keyout', keyPath, '-out', certPath,
    '-days', String(days), '-nodes',
    '-subj', subject,
    '-addext', `keyUsage=critical,${keyUsage}`,
    '-addext', `extendedKeyUsage=${extendedKeyUsage}`
  ]
  try {
    execFileSync(openssl, args, { stdio: 'pipe' })
  } catch (error) {
    const detail = error?.stderr?.toString?.() ?? error?.message ?? String(error)
    throw new Error(`openssl failed to create the certificate: ${detail}`)
  }

  try {
    execFileSync(openssl, [
      'pkcs12', '-export', '-out', p12Path,
      '-inkey', keyPath, '-in', certPath,
      '-passout', `pass:${passphrase}`,
      '-name', escapeSubjPart(commonName)
    ], { stdio: 'pipe' })
  } catch (error) {
    const detail = error?.stderr?.toString?.() ?? error?.message ?? String(error)
    throw new Error(`openssl failed to bundle the PKCS#12 file: ${detail}`)
  }

  return {
    keyPath,
    certPath,
    p12Path,
    p12Bytes: readFileSync(p12Path).length,
    subject,
    days,
    openssl,
    warning:
      'Self-signed certificate: signatures verify as intact but UNTRUSTED in PDF readers. ' +
      'Use a certificate from a real CA when a reader must show the signature as trusted.'
  }
}

/** Bundle an existing key + certificate pair into a PKCS#12 file. */
export function bundleP12(options) {
  const { keyPath, certPath, p12Path, passphrase, alias = 'signing' } = options
  if (!existsSync(keyPath)) throw new Error(`key file not found: ${keyPath}`)
  if (!existsSync(certPath)) throw new Error(`certificate file not found: ${certPath}`)
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    throw new Error('passphrase is required (use an empty string only if the key is unprotected)')
  }
  const openssl = resolveOpenssl()
  try {
    execFileSync(openssl, [
      'pkcs12', '-export', '-out', p12Path,
      '-inkey', keyPath, '-in', certPath,
      '-passout', `pass:${passphrase}`,
      '-name', String(alias)
    ], { stdio: 'pipe' })
  } catch (error) {
    const detail = error?.stderr?.toString?.() ?? error?.message ?? String(error)
    throw new Error(`openssl failed to bundle the PKCS#12 file: ${detail}`)
  }
  return { p12Path, p12Bytes: readFileSync(p12Path).length }
}

/** Load the lazily-imported @signpdf modules (CommonJS, so unwrap defaults). */
async function loadSignedPdf() {
  const [signpdfMod, signerMod, placeholderMod] = await Promise.all([
    import('@signpdf/signpdf'),
    import('@signpdf/signer-p12'),
    import('@signpdf/placeholder-pdf-lib')
  ])
  const SignPdf = signpdfMod.SignPdf ?? signpdfMod.default?.SignPdf ?? signpdfMod.default
  const P12Signer = signerMod.P12Signer ?? signerMod.default?.P12Signer ?? signerMod.default
  const pdflibAddPlaceholder =
    placeholderMod.pdflibAddPlaceholder ?? placeholderMod.default?.pdflibAddPlaceholder
  if (typeof SignPdf !== 'function' || typeof P12Signer !== 'function' || typeof pdflibAddPlaceholder !== 'function') {
    throw new Error('@signpdf modules loaded but did not expose the expected API')
  }
  return { SignPdf, P12Signer, pdflibAddPlaceholder }
}

/**
 * Apply a PKCS#7 detached signature to a PDF.
 *
 * The placeholder must be written without object streams for the signature to
 * be embeddable, so this saves with `useObjectStreams: false` — that is a
 * requirement of the incremental-update signing scheme, not a preference.
 * @param options - source/target paths, certificate, and signature metadata.
 * @returns the signed file's path, size and the metadata recorded in it.
 */
export async function signPdfDigital(options) {
  const {
    pdfPath,
    outputPath,
    p12Path,
    passphrase,
    reason = 'Approved',
    name,
    location,
    contactInfo,
    signingTime,
    subFilter = SUBFILTERS['adbe.pkcs7.detached'],
    signatureLength,
    widgetRect,
    page
  } = options

  if (typeof pdfPath !== 'string' || pdfPath.length === 0) throw new Error('pdfPath is required')
  if (typeof outputPath !== 'string' || outputPath.length === 0) throw new Error('outputPath is required')
  if (typeof p12Path !== 'string' || p12Path.length === 0) {
    throw new Error('p12Path is required: supply your own .p12/.pfx (see pdf_sign_cert_generate to create a self-signed one for testing)')
  }
  if (!existsSync(pdfPath)) throw new Error(`PDF not found: ${pdfPath}`)
  if (!existsSync(p12Path)) throw new Error(`PKCS#12 file not found: ${p12Path}`)
  if (subFilter !== SUBFILTERS['adbe.pkcs7.detached'] && subFilter !== SUBFILTERS['ETSI.CAdES.detached']) {
    throw new Error(`unsupported subFilter "${subFilter}"; use ${Object.keys(SUBFILTERS).join(' or ')}`)
  }

  const { SignPdf, P12Signer, pdflibAddPlaceholder } = await loadSignedPdf()
  const doc = await PDFDocument.load(readFileSync(pdfPath), { ignoreEncryption: true })

  const pages = doc.getPages()
  const targetIndex = page === undefined || page === 'last'
    ? pages.length - 1
    : Number(page) - 1
  if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= pages.length) {
    throw new Error(`page ${String(page)} is out of range (document has ${pages.length} page(s))`)
  }

  const placeholder = {
    pdfDoc: doc,
    reason: String(reason),
    contactInfo: String(contactInfo ?? ''),
    name: String(name ?? ''),
    location: String(location ?? ''),
    subFilter,
    ...(signingTime !== undefined ? { signingTime: signingTime instanceof Date ? signingTime : new Date(signingTime) } : {}),
    ...(signatureLength !== undefined ? { signatureLength: Number(signatureLength) } : {}),
    ...(widgetRect !== undefined ? { widgetRect } : { pdfPage: pages[targetIndex] })
  }
  pdflibAddPlaceholder(placeholder)

  const withPlaceholder = await doc.save({ useObjectStreams: false })
  const signer = new P12Signer(readFileSync(p12Path), { passphrase: String(passphrase ?? '') })
  const signingDate = signingTime instanceof Date ? signingTime : (signingTime ? new Date(signingTime) : new Date())
  const signed = await new SignPdf().sign(withPlaceholder, signer, signingDate)
  writeFileSync(outputPath, signed)

  return {
    path: outputPath,
    bytes: signed.length,
    pageCount: pages.length,
    signedPage: targetIndex + 1,
    subFilter,
    identity: { name: String(name ?? ''), reason: String(reason), location: String(location ?? '') },
    integrity: 'detached CMS signature over the whole file except the signature placeholder',
    warning:
      'Trust depends entirely on the certificate you supplied. A self-signed certificate yields a signature that ' +
      'readers validate as intact but display as untrusted/unknown signer.'
  }
}

/**
 * Inspect a PDF for signatures and signature placeholders.
 *
 * Reports what can be established without a trust store: whether signature
 * fields exist, how many byte ranges are signed, and what metadata the
 * placeholder records. It does **not** claim to verify cryptographic validity —
 * that needs the signer's certificate chain and is a reader's job.
 * @param pdfPath - the PDF to inspect.
 * @returns structural findings and per-field metadata.
 */
export async function inspectPdfSignatures(pdfPath) {
  if (!existsSync(pdfPath)) throw new Error(`PDF not found: ${pdfPath}`)
  const bytes = readFileSync(pdfPath)
  const raw = bytes.toString('latin1')
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false })

  const fields = []
  try {
    for (const field of doc.getForm().getFields()) {
      const type = field.constructor?.name ?? 'Unknown'
      fields.push({ name: field.getName(), type })
    }
  } catch {
    // A malformed or partially-encrypted AcroForm is not fatal for inspection.
  }

  const byteRangeCount = (raw.match(/\/ByteRange\s*\[/g) ?? []).length
  const subFilters = [...new Set(raw.match(/\/SubFilter\s*\/([A-Za-z0-9.]+)/g) ?? [])].map((s) =>
    s.replace(/\/SubFilter\s*\//, '')
  )
  const metadata = {}
  for (const key of ['Name', 'Reason', 'Location', 'ContactInfo', 'M']) {
    const match = new RegExp(`/${key}\\s*\\(([^)]*)\\)`).exec(raw)
    if (match) metadata[key] = match[1]
  }

  return {
    path: pdfPath,
    bytes: bytes.length,
    pageCount: doc.getPageCount(),
    formFields: fields,
    signatureFieldCount: fields.filter((f) => /Sig/i.test(f.type)).length,
    byteRangeCount,
    subFilters,
    metadata,
    hasSignature: byteRangeCount > 0,
    note:
      'Structural inspection only. Cryptographic verification requires the signer certificate chain and is not performed here.'
  }
}

/** Resolve a path relative to an optional base directory. */
export function resolvePath(baseDir, filePath) {
  return baseDir === undefined ? resolve(filePath) : resolve(baseDir, filePath)
}

/** Report the directory a path lives in (used for default output locations). */
export function directoryOf(filePath) {
  return dirname(resolve(filePath))
}

/** Convenience re-export for callers building default sibling output paths. */
export function siblingPath(filePath, suffix, extension) {
  const absolute = resolve(filePath)
  const dir = dirname(absolute)
  const base = absolute.slice(dir.length + 1).replace(/\.[^.]+$/, '')
  return join(dir, `${base}${suffix}${extension ?? ''}`)
}
