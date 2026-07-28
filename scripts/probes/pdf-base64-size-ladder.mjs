/**
 * Probe: send a PDF as base64 inside the string `content` at increasing sizes,
 * to find where chat-generations cuts it off — request-size limit, token/context
 * limit, timeout, or silent truncation.
 *
 * Two things are being measured, and they fail at different points:
 *   1. TRANSPORT — does the request survive at all (HTTP status / error code)?
 *   2. CONTEXT   — how many input tokens the payload becomes (`inputTokenCount`
 *      from the usage block). If that plateaus while the payload keeps growing,
 *      the platform is silently truncating rather than erroring.
 *
 * Separately, `PDF_READABLE` / `TITLE` in the reply test whether any of it is
 * actually intelligible to the model. Expect no: a PDF's text lives in
 * FlateDecode-compressed streams, so base64 of those bytes is noise unless the
 * model both decodes base64 and inflates zlib. Truncating also corrupts the PDF
 * (the xref table is at the tail), so any real PDF parser would reject it too.
 *
 * Usage:
 *   node scripts/probes/pdf-base64-size-ladder.mjs "MIMIT Admin Guide .pdf"
 *   node scripts/probes/pdf-base64-size-ladder.mjs <file.pdf> <modelId>
 */
import fs from "node:fs"
import path from "node:path"
import { getToken, loadEnv, oneLine, postChat, resolveModels, ROOT } from "./probe-lib.mjs"

loadEnv()

const file = process.argv[2]
if (!file) {
  console.error("usage: node scripts/probes/pdf-base64-size-ladder.mjs <file.pdf> [modelId]")
  process.exit(1)
}
const model = resolveModels(process.argv[3])[0]

const full = path.isAbsolute(file) ? file : path.join(ROOT, file)
const bytes = fs.readFileSync(full)

/** Base64 payload sizes to try, in characters. */
const LADDER = [
  1_000, 10_000, 50_000, 100_000, 250_000, 500_000,
  1_000_000, 2_000_000, 4_000_000, 8_000_000,
]

/** Generous per-request bound — big bodies are slow; distinguishes hang from reject. */
const REQUEST_TIMEOUT_MS = 180_000

const ASK =
  "Below is a base64-encoded PDF document (it may be truncated).\n" +
  "Reply with exactly three lines and nothing else:\n" +
  "PDF_READABLE: <yes if you can actually extract the document's contents, no if it is unintelligible>\n" +
  "TITLE: <the document's title, or unknown>\n" +
  "TOPIC: <what the document is about in 3 words, or unknown>"

/** Truncate to a byte count whose base64 is ~`chars` long, then encode. */
function payloadOfChars(chars) {
  const byteLen = Math.min(bytes.length, Math.floor((chars / 4) * 3))
  return bytes.subarray(0, byteLen).toString("base64")
}

const token = await getToken()
const fullB64Chars = Math.ceil(bytes.length / 3) * 4

console.log(`file    ${path.basename(full)}`)
console.log(`size    ${bytes.length.toLocaleString()} bytes → ${fullB64Chars.toLocaleString()} base64 chars`)
console.log(`model   ${model}`)
console.log(`ladder  ${LADDER.length} steps, ${REQUEST_TIMEOUT_MS / 1000}s per-request cap\n`)

const rows = []
let consecutiveFailures = 0

for (const chars of LADDER) {
  if (chars > fullB64Chars) {
    console.log(`${chars.toLocaleString().padStart(11)} chars — exceeds the file; stopping`)
    break
  }
  const b64 = payloadOfChars(chars)
  const body = JSON.stringify({ messages: [{ role: "user", content: `${ASK}\n\n${b64}` }] })
  const reqMB = (Buffer.byteLength(body) / 1024 / 1024).toFixed(2)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  const started = Date.now()
  let r, err
  try {
    r = await postChat(token, model, { body, signal: controller.signal })
  } catch (e) {
    err = e.name === "AbortError" ? `TIMEOUT after ${REQUEST_TIMEOUT_MS / 1000}s` : e.message
  } finally {
    clearTimeout(timer)
  }
  const secs = ((Date.now() - started) / 1000).toFixed(1)

  if (err) {
    rows.push({ chars, reqMB, status: "—", secs, inputTokens: "—", note: err })
    console.log(`${chars.toLocaleString().padStart(11)} chars · ${reqMB} MB · ${secs}s · ${err}`)
    if (++consecutiveFailures >= 2) {
      console.log("\ntwo consecutive failures — stopping ladder")
      break
    }
    continue
  }

  let usage = null
  try {
    usage = JSON.parse(r.text)?.generationDetails?.parameters?.usage ?? null
  } catch {}
  const inputTokens = usage?.inputTokenCount ?? usage?.prompt_tokens ?? null
  let errorCode = null
  try {
    errorCode = JSON.parse(r.text)?.errorCode ?? null
  } catch {}

  const ok = r.status === 200
  consecutiveFailures = ok ? 0 : consecutiveFailures + 1
  rows.push({
    chars,
    reqMB,
    status: r.status,
    secs,
    inputTokens: inputTokens ?? "—",
    note: ok ? oneLine(r.reply, 90) : `${errorCode ?? ""} ${oneLine(r.text, 110)}`,
  })

  console.log(
    `${chars.toLocaleString().padStart(11)} chars · ${reqMB} MB · ${secs}s · ${r.status}` +
      (inputTokens ? ` · ${inputTokens.toLocaleString()} input tokens` : "") +
      `\n    ${ok ? oneLine(r.reply, 200) : oneLine(r.text, 200)}`
  )

  if (!ok && consecutiveFailures >= 2) {
    console.log("\ntwo consecutive failures — stopping ladder")
    break
  }
}

console.log(`\n${"base64 chars".padEnd(14)}${"req MB".padEnd(9)}${"status".padEnd(8)}${"secs".padEnd(7)}${"input tokens".padEnd(14)}note`)
for (const r of rows) {
  console.log(
    `${r.chars.toLocaleString().padEnd(14)}${String(r.reqMB).padEnd(9)}${String(r.status).padEnd(8)}` +
      `${String(r.secs).padEnd(7)}${String(r.inputTokens).padEnd(14)}${r.note}`
  )
}
console.log(
  `\nNote: the app aborts a generation at GENERATION_TIMEOUT_MS (28s, config/models.ts)\n` +
    `to beat Heroku's H12 — any step slower than that is unusable in the app even if it returns 200.`
)
