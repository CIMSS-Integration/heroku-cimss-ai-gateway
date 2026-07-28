import "server-only"
import zlib from "node:zlib"
import {
  ACCEPTED_TYPES,
  KNOWN_REJECTED,
  MIN_EXTRACTED_CHARS,
  type AttachmentKind,
} from "@/config/attachments"

/**
 * Server-side text extraction for uploaded attachments.
 *
 * The model receives extracted text, never the file bytes — see
 * `config/attachments.ts` for why. Extraction therefore has to be honest about
 * failure: a PDF of scanned pages yields no text, and returning an empty string
 * would silently send the model an "attachment" containing nothing. Every path
 * here either produces real text or throws `ExtractionError`.
 */

/** A user-facing extraction failure. `message` is safe to show verbatim. */
export class ExtractionError extends Error {
  readonly status: number
  constructor(message: string, status = 400) {
    super(message)
    this.name = "ExtractionError"
    this.status = status
  }
}

export type ExtractedDocument = {
  kind: AttachmentKind
  text: string
  /** Page count, for PDFs only. */
  pages?: number
}

/** Lowercase extension including the dot, or "" if the name has none. */
export function extensionOf(filename: string): string {
  const match = /\.[^.\\/]+$/.exec(filename.trim().toLowerCase())
  return match ? match[0] : ""
}

/**
 * Resolve an upload's extension to a supported kind, or throw with the most
 * specific message available — naming *why* a `.doc` or a `.png` was refused is
 * far more useful than a generic "unsupported file".
 */
export function kindFor(filename: string): AttachmentKind {
  const ext = extensionOf(filename)
  const accepted = ACCEPTED_TYPES.find((t) => t.ext === ext)
  if (accepted) return accepted.kind

  const known = KNOWN_REJECTED.find((r) => r.exts.includes(ext))
  if (known) throw new ExtractionError(known.reason)

  throw new ExtractionError(
    ext
      ? `${ext} files aren't supported. Upload a .txt, .docx, or .pdf.`
      : "That file has no extension, so its type can't be determined. Upload a .txt, .docx, or .pdf."
  )
}

// --- plain text --------------------------------------------------------------

/** Decode UTF-8, dropping a BOM and normalizing line endings. */
function decodeText(buf: Buffer): string {
  let text = buf.toString("utf8")
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  return text.replace(/\r\n?/g, "\n")
}

/**
 * A .txt that's actually binary decodes to U+FFFD replacement characters (and
 * often keeps literal NULs); catching that here stops a mislabeled file from
 * reaching the model as mojibake. Both characters are written as escapes — a
 * literal NUL in the source would make this file read as binary to git/grep.
 */
function looksBinary(text: string): boolean {
  if (!text) return false
  const suspicious = (text.match(/[\uFFFD\u0000]/g) ?? []).length
  return suspicious / text.length > 0.05
}

// --- .docx -------------------------------------------------------------------

type ZipEntry = { name: string; method: number; offset: number; compressedSize: number }

/**
 * Minimal ZIP central-directory reader — enough to pull one part out of a
 * .docx. Hand-rolled rather than pulling in a zip dependency: a .docx only ever
 * needs `word/document.xml`, and Node already ships the inflate.
 */
function readZipEntries(buf: Buffer): ZipEntry[] {
  // The end-of-central-directory record sits at the tail, after an optional
  // comment, so scan backwards for its signature.
  const MAX_COMMENT = 0xffff
  const start = Math.max(0, buf.length - MAX_COMMENT - 22)
  let eocd = -1
  for (let i = buf.length - 22; i >= start; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) {
    throw new ExtractionError(
      "That .docx file appears to be corrupt (no ZIP directory found)."
    )
  }

  const count = buf.readUInt16LE(eocd + 10)
  let pos = buf.readUInt32LE(eocd + 16)
  const entries: ZipEntry[] = []
  for (let i = 0; i < count; i++) {
    if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== 0x02014b50) break
    const method = buf.readUInt16LE(pos + 10)
    const compressedSize = buf.readUInt32LE(pos + 20)
    const nameLen = buf.readUInt16LE(pos + 28)
    const extraLen = buf.readUInt16LE(pos + 30)
    const commentLen = buf.readUInt16LE(pos + 32)
    const offset = buf.readUInt32LE(pos + 42)
    const name = buf.subarray(pos + 46, pos + 46 + nameLen).toString("utf8")
    entries.push({ name, method, offset, compressedSize })
    pos += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

/** Read and decompress one ZIP entry via its local file header. */
function readZipEntry(buf: Buffer, entry: ZipEntry): Buffer {
  if (buf.readUInt32LE(entry.offset) !== 0x04034b50) {
    throw new ExtractionError("That .docx file appears to be corrupt.")
  }
  const nameLen = buf.readUInt16LE(entry.offset + 26)
  const extraLen = buf.readUInt16LE(entry.offset + 28)
  const dataStart = entry.offset + 30 + nameLen + extraLen
  const data = buf.subarray(dataStart, dataStart + entry.compressedSize)
  if (entry.method === 0) return Buffer.from(data)
  if (entry.method === 8) {
    try {
      return zlib.inflateRawSync(data)
    } catch {
      throw new ExtractionError("That .docx file couldn't be decompressed.")
    }
  }
  throw new ExtractionError(
    `That .docx uses an unsupported compression method (${entry.method}).`
  )
}

const XML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
}

/**
 * Turn WordprocessingML into readable text. Paragraph and break elements become
 * newlines *before* tags are stripped, so the document keeps its structure
 * instead of collapsing into one line.
 */
function wordXmlToText(xml: string): string {
  return xml
    .replace(/<w:tab\b[^>]*\/?>/g, "\t")
    .replace(/<w:br\b[^>]*\/?>/g, "\n")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<\/w:tr>/g, "\n")
    .replace(/<\/w:tc>/g, "\t")
    .replace(/<[^>]+>/g, "")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&(amp|lt|gt|quot|apos);/g, (m) => XML_ENTITIES[m] ?? m)
    // A table cell closes its paragraph before the cell itself, which would
    // leave every cell on its own line; keep rows on one tab-separated line.
    .replace(/\n+\t/g, "\t")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

function extractDocx(buf: Buffer): string {
  const entries = readZipEntries(buf)
  const main = entries.find((e) => e.name === "word/document.xml")
  if (!main) {
    throw new ExtractionError(
      "That doesn't look like a Word document (no word/document.xml inside)."
    )
  }
  const parts = [wordXmlToText(readZipEntry(buf, main).toString("utf8"))]

  // Headers/footers often carry titles and reference numbers worth including.
  for (const entry of entries) {
    if (/^word\/(header|footer)\d*\.xml$/.test(entry.name)) {
      const text = wordXmlToText(readZipEntry(buf, entry).toString("utf8"))
      if (text) parts.push(text)
    }
  }
  return parts.filter(Boolean).join("\n\n")
}

// --- .pdf --------------------------------------------------------------------

/**
 * Extract text with pdf.js. The `legacy` build is the one that runs under Node;
 * the worker is disabled because there's no Worker global here, and font/eval
 * features are turned off since we only ever want the text layer.
 */
async function extractPdf(buf: Buffer): Promise<{ text: string; pages: number }> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs")

  let doc
  try {
    doc = await pdfjs.getDocument({
      data: new Uint8Array(buf),
      // Only the text layer is wanted, so skip all font machinery.
      disableFontFace: true,
      useSystemFonts: false,
      // Without this pdf.js logs a warning per missing standard font.
      verbosity: 0,
    }).promise
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (/password/i.test(message)) {
      throw new ExtractionError(
        "That PDF is password-protected. Remove the password and try again."
      )
    }
    throw new ExtractionError(`That PDF couldn't be read (${message}).`)
  }

  const pages: string[] = []
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i)
      const content = await page.getTextContent()
      // `items` mixes text runs and layout marks; only text runs carry `str`.
      // `hasEOL` marks a line end, which is the only line-break signal available.
      const text = content.items
        .map((item) =>
          "str" in item ? item.str + (item.hasEOL ? "\n" : "") : ""
        )
        .join("")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim()
      if (text) pages.push(text)
      page.cleanup()
    }
  } finally {
    // pdf.js v6: teardown lives on the loading task, not the document proxy.
    await doc.loadingTask.destroy()
  }

  return { text: pages.join("\n\n"), pages: doc.numPages }
}

// --- entry point -------------------------------------------------------------

/**
 * Extract text from an uploaded file. Throws `ExtractionError` with a
 * user-facing message for anything that can't produce usable text — including
 * the important case of a PDF that parses fine but has no text layer.
 */
export async function extractText(
  filename: string,
  bytes: Buffer
): Promise<ExtractedDocument> {
  const kind = kindFor(filename)

  if (bytes.length === 0) {
    throw new ExtractionError("That file is empty.")
  }

  let text: string
  let pages: number | undefined

  if (kind === "txt") {
    text = decodeText(bytes).trim()
    if (looksBinary(text)) {
      throw new ExtractionError(
        "That .txt file doesn't appear to be readable text (it may be binary or use an unsupported encoding)."
      )
    }
  } else if (kind === "docx") {
    text = extractDocx(bytes)
  } else {
    const result = await extractPdf(bytes)
    text = result.text
    pages = result.pages
  }

  if (text.length < MIN_EXTRACTED_CHARS) {
    throw new ExtractionError(
      kind === "pdf"
        ? "No text could be extracted from that PDF — it's likely a scan or images of pages. " +
          "Text-recognition (OCR) isn't available, so upload a text-based PDF or paste the text instead."
        : "No readable text could be extracted from that file."
    )
  }

  return { kind, text, pages }
}
