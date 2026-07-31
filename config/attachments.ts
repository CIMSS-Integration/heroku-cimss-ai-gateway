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

import { tokenFactorFor } from "./models"

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
 * Rough characters-per-token for English prose. Retained for callers that only
 * need a coarse character budget; `estimateTokens` no longer uses it.
 */
export const CHARS_PER_TOKEN = 4

/**
 * Structural token estimate, tokenizer-agnostic.
 *
 * A flat chars-per-token ratio is badly wrong for anything that isn't prose,
 * which is what this replaces. `text.length / 4` under-counted an 819 KB SQL
 * script by 2.24x on Claude — reporting ~205k tokens for what actually cost
 * 458,916 — so the file read as a comfortable fit and was then rejected outright
 * by the platform.
 *
 * The dominant effect is that real tokenizers do NOT charge per character; they
 * charge per *symbol*. Punctuation and digits are near one token each, while a
 * common word of any length is often a single token. SQL is mostly punctuation,
 * identifiers, and long digit runs — the worst case — whereas prose is mostly
 * word runs. So we count structure instead of length:
 *
 *   - a run of letters   → ceil(run / 4), approximating BPE word merging
 *   - each digit         → 1  (long numerals really do cost ~1 token per digit)
 *   - each punctuation / symbol / non-ASCII char → 1
 *   - newline            → 1
 *   - space, tab, CR     → free (absorbed into adjacent tokens)
 *
 * On the measured SQL payload this yields ~0.41 tokens/char, against the flat
 * ratio's 0.25 and the real 0.56 (Claude) / 0.35 (Gemini) — close enough that a
 * single per-family multiplier (`tokenFactor`) lands within a few percent, which
 * one flat constant could never do for both families at once.
 *
 * Single O(n) pass with no allocation: this runs on uploads up to
 * MAX_UPLOAD_BYTES, where a regex-match-per-symbol approach would allocate
 * millions of objects.
 */
function structuralTokens(text: string): number {
  let tokens = 0
  let letterRun = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) {
      letterRun++
      continue
    }
    if (letterRun > 0) {
      tokens += Math.ceil(letterRun / 4)
      letterRun = 0
    }
    if (c === 32 || c === 9 || c === 13) continue // space, tab, CR
    tokens += 1 // newline, digit, punctuation, symbol, non-ASCII
  }
  if (letterRun > 0) tokens += Math.ceil(letterRun / 4)
  return tokens
}

/**
 * Symbol density of a text: structural tokens per flat chars/4 token. ~1.09 for
 * English prose, ~1.63 for SQL. This is the knob that tells prose apart from code
 * without needing to know the file type.
 */
function symbolDensity(text: string, structural: number): number {
  const flat = Math.ceil(text.length / CHARS_PER_TOKEN)
  if (flat <= 0) return PROSE_DENSITY
  // Clamped to the range we actually measured. Outside it we would be
  // extrapolating a straight line with no data behind it — an all-punctuation
  // file would otherwise be estimated at over 2x its true cost.
  return Math.min(Math.max(structural / flat, PROSE_DENSITY), SQL_DENSITY)
}

/** Measured density of English prose — the anchor `tokenFactor` is calibrated at. */
const PROSE_DENSITY = 1.087
/** Measured density of the SQL maintenance scripts — the dense end of the range. */
const SQL_DENSITY = 1.634

/**
 * How much the calibration factor rises per unit of symbol density.
 *
 * Measured 2026-07-30, same payloads on both models. The needed factor moves with
 * density at almost the same rate for both families — slope 0.59 for Gemini, 0.52
 * for Claude — so one shared sensitivity plus a per-model prose baseline fits both
 * anchors, rather than needing a full curve per model:
 *
 *   model    prose (d=1.087)   SQL (d=1.634)
 *   Gemini   0.545             0.869
 *   Claude   1.085             1.370
 *
 * 0.6 is used rather than the fitted ~0.55 so that the residual error at the
 * dense end is positive on both models (+0.5% Gemini, +3.1% Claude) — over- not
 * under-estimating, since under-estimating is what causes a hard rejection.
 */
const DENSITY_SENSITIVITY = 0.6

/**
 * Estimated input tokens for a chunk of text, calibrated for the target model and
 * the text's own symbol density.
 *
 * Both inputs matter, and a single constant cannot stand in for either. Measured
 * chars-per-token across the two extremes:
 *
 *              prose   SQL
 *   Gemini     6.75    2.82
 *   Claude     3.39    1.79
 *
 * That is a 2.4x swing across content types and a 2x swing across models — so the
 * old flat `length / 4` was wrong by -30% to -55% on SQL, while a fixed per-model
 * multiplier tuned to fix that would have inflated ordinary prose by ~1.5x and
 * started rejecting .docx/.pdf uploads that fit perfectly well.
 *
 * Pass `modelId` wherever it's known. Omitting it assumes the most expensive
 * measured family, so an unattributed estimate errs high — a premature warning
 * rather than a hard platform rejection.
 */
export function estimateTokens(text: string, modelId?: string | null): number {
  const structural = structuralTokens(text)
  if (structural === 0) return 0
  const density = symbolDensity(text, structural)
  const factor =
    tokenFactorFor(modelId ?? null) +
    DENSITY_SENSITIVITY * (density - PROSE_DENSITY)
  return Math.ceil(structural * Math.max(0.3, factor))
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
