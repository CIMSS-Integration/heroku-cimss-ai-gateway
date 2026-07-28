/**
 * File-attachment configuration.
 *
 * Attachments are sent to the model as **extracted plain text**, not as base64.
 * That is a measured decision, not a preference: base64-encoded `.docx`/`.pdf`
 * failed on all 6 configured models (their text lives in compressed streams the
 * model can't inflate), and several models then *fabricated* answers rather than
 * reporting failure. Plain text worked on 6/6 and costs ~2.4x fewer tokens for
 * the same content. See docs/ARCHITECTURE.md → "Multimodal / file input is not
 * possible on chat-generations" and `scripts/probes/document-base64-by-type.mjs`.
 */

export type AttachmentKind = "txt" | "docx" | "pdf"

export type AcceptedType = {
  /** Lowercase file extension, with the dot. */
  ext: string
  kind: AttachmentKind
  /** Shown in the picker and in error messages. */
  label: string
}

export const ACCEPTED_TYPES: AcceptedType[] = [
  { ext: ".txt", kind: "txt", label: "Text" },
  { ext: ".docx", kind: "docx", label: "Word" },
  { ext: ".pdf", kind: "pdf", label: "PDF" },
]

/** `accept` attribute for the file input. Advisory only — the server re-checks. */
export const ACCEPT_ATTR = ACCEPTED_TYPES.map((t) => t.ext).join(",")

/** Human list for error copy: ".txt, .docx, .pdf". */
export const ACCEPTED_LIST = ACCEPTED_TYPES.map((t) => t.ext).join(", ")

/**
 * Largest upload accepted, in bytes.
 *
 * Must stay under `experimental.proxyClientMaxBodySize` in `next.config.ts`
 * (set to 30mb to match). This app runs `proxy.ts`, and Next buffers the whole
 * request body when a proxy is present; past that limit the body is truncated
 * rather than rejected, which would surface as a corrupt-file error instead of a
 * size one. **Raise both together or neither.**
 *
 * 25 MB covers essentially every text document while keeping peak memory sane on
 * a small dyno (the body is buffered by the proxy *and* again as an ArrayBuffer
 * for extraction, so a 25 MB upload costs ~50 MB+ before pdf.js starts).
 * Image-heavy PDFs can exceed this while containing very little text — the
 * 65 MB `MIMIT Admin Guide .pdf` is 877 screenshots wrapping only ~112k
 * characters. Those need the limits raised, accepting the memory cost.
 */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024

/**
 * Legacy/again-rejected extensions we can name specifically, so the error says
 * something more useful than "unsupported". `.doc` is OLE-compound binary (a
 * different format from `.docx`, not just an older one) and images have no text
 * to extract — the Models API can't accept them in any form.
 */
export const KNOWN_REJECTED: { exts: string[]; reason: string }[] = [
  {
    exts: [".doc"],
    reason:
      "Legacy .doc files aren't supported. Open it in Word and save as .docx, then try again.",
  },
  {
    exts: [
      ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff",
      ".svg", ".heic", ".heif", ".avif", ".ico",
    ],
    reason:
      "Images aren't supported — the Salesforce Models API is text-only and can't accept them.",
  },
  {
    exts: [".xlsx", ".xls", ".csv", ".pptx", ".ppt"],
    reason:
      "Spreadsheets and presentations aren't supported yet. Copy the relevant text into the message, or upload a .txt/.docx/.pdf.",
  },
  {
    exts: [".zip", ".rar", ".7z", ".tar", ".gz"],
    reason: "Archives aren't supported. Upload the document itself (.txt, .docx, .pdf).",
  },
]

/**
 * Rough characters-per-token for English prose. Only an estimate — the Models
 * API doesn't expose a tokenizer — so the context check leaves headroom below
 * rather than pretending to be exact.
 */
export const CHARS_PER_TOKEN = 4

/** Estimated input tokens for a chunk of text. Deliberately conservative. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

/**
 * Tokens held back from the window when deciding whether an attachment fits:
 * the system prompt, the user's own message, the model's reply, and the slack
 * needed because `estimateTokens` is an approximation. Without this an
 * attachment that "just fits" would push the very next turn over the limit.
 */
export const CONTEXT_RESERVE_TOKENS = 8_000

/**
 * Ceiling on how much of the remaining window one attachment may claim, so a
 * document can't crowd out the conversation itself.
 */
export const MAX_CONTEXT_SHARE = 0.6

/** Minimum extracted characters before we treat a file as having real text. */
export const MIN_EXTRACTED_CHARS = 16
