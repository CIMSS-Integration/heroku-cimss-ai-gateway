import { NextResponse } from "next/server"
import { auth } from "@clerk/nextjs/server"
import { extractText, ExtractionError } from "@/lib/extract-text"
import { contextWindowFor, MODELS } from "@/config/models"
import {
  CONTEXT_RESERVE_TOKENS,
  MAX_CONTEXT_SHARE,
  MAX_UPLOAD_BYTES,
  estimateTokens,
} from "@/config/attachments"

/**
 * Extract an uploaded document to plain text for inclusion in a chat message.
 *
 * The file never reaches the Models API as bytes — that endpoint is text-only,
 * and base64 passthrough was measured to fail on every configured model (see
 * config/attachments.ts). This route does the extraction and the context-fit
 * arithmetic server-side so both live in one place, and returns text the client
 * prepends to the user's message.
 */

// zlib + pdf.js are Node APIs; extraction is per-request work.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const MB = 1024 * 1024

/** Bytes → a short human string for error copy. */
function humanSize(bytes: number): string {
  if (bytes >= MB) return `${(bytes / MB).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

function fail(error: string, status: number, code?: string) {
  return NextResponse.json(code ? { error, code } : { error }, { status })
}

export async function POST(request: Request) {
  const { userId } = await auth()
  if (!userId) return fail("Unauthorized", 401)

  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return fail("That upload couldn't be read. Try again.", 400)
  }

  const file = form.get("file")
  if (!(file instanceof File)) {
    return fail("No file was included in the upload.", 400)
  }

  // Checked before reading the bytes: past Next's proxyClientMaxBodySize (10 MB
  // default, and this app runs proxy.ts) the body is truncated rather than
  // rejected, which would surface as a corrupt-file error instead of a size one.
  if (file.size > MAX_UPLOAD_BYTES) {
    return fail(
      `That file is ${humanSize(file.size)} — the limit is ${humanSize(MAX_UPLOAD_BYTES)}. ` +
        `Upload a smaller file, or paste the relevant section as text.`,
      413,
      "too_large"
    )
  }

  // Optional context-fit check. The model and the conversation's current token
  // usage come from the client because only it knows which chat this is for.
  const modelField = form.get("model")
  const model =
    typeof modelField === "string" && MODELS.some((m) => m.id === modelField)
      ? modelField
      : null
  const usedField = form.get("usedTokens")
  const usedTokens =
    typeof usedField === "string" && Number.isFinite(Number(usedField))
      ? Math.max(0, Math.floor(Number(usedField)))
      : 0

  let extracted
  try {
    const bytes = Buffer.from(await file.arrayBuffer())
    extracted = await extractText(file.name, bytes)
  } catch (err) {
    if (err instanceof ExtractionError) {
      return fail(err.message, err.status, "extraction_failed")
    }
    console.error("[attach] extraction failed", err)
    return fail("That file couldn't be processed.", 500)
  }

  // Calibrated to the target model — the same text can cost ~1.6x more on Claude
  // than on Gemini, so an uncalibrated figure here would mislead the user about
  // whether their document fits.
  const estTokens = estimateTokens(extracted.text, model)

  if (model) {
    const window = contextWindowFor(model)
    // Room left for an attachment: the window minus what this chat already
    // occupies and a reserve for the reply, then capped so one document can't
    // crowd out the conversation.
    const remaining = Math.max(0, window - usedTokens - CONTEXT_RESERVE_TOKENS)
    const allowance = Math.floor(remaining * MAX_CONTEXT_SHARE)
    if (estTokens > allowance) {
      const label = MODELS.find((m) => m.id === model)?.label ?? model
      return fail(
        `That file is too large for this chat: about ${estTokens.toLocaleString()} tokens of text, ` +
          `but only about ${allowance.toLocaleString()} are available with ${label}` +
          `${usedTokens > 0 ? " at this point in the conversation" : ""}. ` +
          `Upload a shorter document, split it up, or start a new chat.`,
        413,
        "context_limit"
      )
    }
  }

  return NextResponse.json({
    name: file.name,
    kind: extracted.kind,
    pages: extracted.pages ?? null,
    chars: extracted.text.length,
    estTokens,
    text: extracted.text,
  })
}
