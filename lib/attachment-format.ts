/**
 * How an attachment is embedded in a message, and how to pull it back out.
 *
 * Shared by client and server (no server-only imports): the composer builds the
 * block before sending, and the transcript strips it back out for display so a
 * 100k-character document doesn't get rendered inside a chat bubble — on a fresh
 * send *and* after resuming a chat from the database, where the stored content is
 * all the UI has to work from.
 *
 * The document text is embedded in the message itself rather than kept
 * elsewhere, because the Models API is a stateless text endpoint: whatever the
 * model needs to see has to be in `messages[].content`.
 */

export type ParsedAttachment = {
  name: string
  text: string
}

const START = (name: string) => `[file: ${name}]`
const END = "[/file]"

/** Matches a whole embedded block, capturing the filename and the body. */
const BLOCK = /^\[file: (.+?)\]\n([\s\S]*?)\n\[\/file\]$/gm

/**
 * Wrap extracted text into the block the model sees. The prose line before the
 * markers matters: without it a model can mistake a long pasted document for the
 * user's own words instead of an attachment to answer questions about.
 */
export function formatAttachmentBlock(opts: {
  name: string
  kindLabel: string
  pages?: number | null
  text: string
}): string {
  const detail = opts.pages
    ? `${opts.kindLabel}, ${opts.pages} ${opts.pages === 1 ? "page" : "pages"}`
    : opts.kindLabel
  return (
    `The user attached a file: "${opts.name}" (${detail}). ` +
    `Its full extracted text is between the markers below.\n\n` +
    `${START(opts.name)}\n${opts.text}\n${END}`
  )
}

/**
 * Compose the final message content: attachment block(s) first, then whatever
 * the user typed, so the question reads as being *about* the document above it.
 */
export function withAttachment(body: string, block: string): string {
  const typed = body.trim()
  return typed ? `${block}\n\n${typed}` : block
}

/**
 * Inverse of the above: split stored content back into its attachments and the
 * user's own text. Returns `attachments: []` and the content unchanged for
 * ordinary messages, so it's safe to call on every message.
 */
export function splitAttachment(content: string): {
  attachments: ParsedAttachment[]
  body: string
} {
  const attachments: ParsedAttachment[] = []
  // `BLOCK` is a module-level regex with /g — reset lastIndex so repeated calls
  // (every message, every render) don't resume mid-string and miss matches.
  BLOCK.lastIndex = 0
  let body = content.replace(BLOCK, (_match, name: string, text: string) => {
    attachments.push({ name, text })
    return ""
  })
  if (attachments.length) {
    // Drop the explanatory preamble that accompanies each block, then tidy the
    // blank lines the removals leave behind.
    body = body
      .replace(/^The user attached a file: ".*?" \(.*?\)\. Its full extracted text is between the markers below\.$/gm, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  }
  return { attachments, body }
}
