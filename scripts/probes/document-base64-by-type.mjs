/**
 * Probe: which document types actually survive being sent as base64 inside the
 * string `content`, on which models?
 *
 * Gates the "attach a file" feature. Every payload below contains the same
 * unguessable canary code; the model is asked to report it. Reporting it is the
 * only proof the document's *contents* arrived — a confident-sounding reply that
 * misses the canary is a fabrication, which is the failure mode that would ship
 * a broken feature.
 *
 * Word and PDF are each generated twice — once compressed (what Word/Google Docs
 * actually emit) and once uncompressed — so a failure can be attributed to
 * compression rather than to the file format. That distinction is the whole
 * question: base64 is a transparent encoding of bytes, so the model can read
 * whatever is plainly ASCII in those bytes and nothing else.
 *
 * The plain-text control sends the same document as ordinary string content, to
 * measure what base64 costs in input tokens for identical information.
 *
 * Usage:
 *   node scripts/probes/document-base64-by-type.mjs        # default model
 *   node scripts/probes/document-base64-by-type.mjs all    # all 6 models
 */
import zlib from "node:zlib"
import { getToken, loadEnv, oneLine, postChat, resolveModels } from "./probe-lib.mjs"

loadEnv()

const CANARY = "ZK-4417-QUARTZ-93"

/** A realistic little document, with the canary buried mid-body. */
const PARAGRAPHS = [
  "MIMIT Internal Operations Memo",
  "This memo summarizes the quarterly reconciliation process for the accounting team.",
  "All adjusting entries must be posted before the period close checklist is signed off.",
  `The authorization code for the Q3 audit is ${CANARY}. Quote it on every submission.`,
  "Questions about the reconciliation schedule should go to the finance operations queue.",
  "Retain supporting documentation for seven years in line with the records policy.",
]
const PLAIN_TEXT = PARAGRAPHS.join("\n\n")

// --- .docx (a ZIP of XML parts) ---------------------------------------------

/** Minimal ZIP writer. `compress` picks deflate (what Word emits) vs stored. */
function zip(entries, compress) {
  const locals = []
  const central = []
  let offset = 0
  for (const [name, textContent] of entries) {
    const raw = Buffer.from(textContent, "utf8")
    const data = compress ? zlib.deflateRawSync(raw) : raw
    const nameBuf = Buffer.from(name, "utf8")
    const crc = zlib.crc32(raw)
    const method = compress ? 8 : 0

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    locals.push(local, nameBuf, data)

    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(20, 4) // version made by
    cd.writeUInt16LE(20, 6) // version needed
    cd.writeUInt16LE(method, 10)
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(data.length, 20)
    cd.writeUInt32LE(raw.length, 24)
    cd.writeUInt16LE(nameBuf.length, 28)
    cd.writeUInt32LE(offset, 42)
    central.push(cd, nameBuf)

    offset += local.length + nameBuf.length + data.length
  }
  const cdBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cdBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cdBuf, eocd])
}

function docx(compress) {
  const body = PARAGRAPHS.map(
    (p) => `<w:p><w:r><w:t xml:space="preserve">${p}</w:t></w:r></w:p>`
  ).join("")
  return zip(
    [
      [
        "[Content_Types].xml",
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
          `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
          `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
          `<Default Extension="xml" ContentType="application/xml"/>` +
          `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
          `</Types>`,
      ],
      [
        "_rels/.rels",
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
          `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
          `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
          `</Relationships>`,
      ],
      [
        "word/document.xml",
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
          `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
          `<w:body>${body}</w:body></w:document>`,
      ],
    ],
    compress
  )
}

// --- .pdf --------------------------------------------------------------------

/** Single-page PDF with real xref offsets; content stream optionally deflated. */
function pdf(compress) {
  const text =
    "BT /F1 11 Tf 1.2 Tf 72 720 Td 14 TL " +
    PARAGRAPHS.map((p) => `(${p.replace(/([()\\])/g, "\\$1")}) Tj T*`).join(" ") +
    " ET"
  const streamData = compress
    ? zlib.deflateSync(Buffer.from(text, "latin1"))
    : Buffer.from(text, "latin1")

  const objects = [
    "<</Type /Catalog /Pages 2 0 R>>",
    "<</Type /Pages /Kids [3 0 R] /Count 1>>",
    "<</Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources <</Font <</F1 4 0 R>>>> /Contents 5 0 R>>",
    "<</Type /Font /Subtype /Type1 /BaseFont /Helvetica>>",
    `<</Length ${streamData.length}${compress ? " /Filter /FlateDecode" : ""}>>`,
  ]

  const chunks = [Buffer.from("%PDF-1.4\n", "latin1")]
  const offsets = []
  let pos = chunks[0].length
  objects.forEach((dict, i) => {
    offsets.push(pos)
    const head = Buffer.from(`${i + 1} 0 obj\n${dict}\n`, "latin1")
    const parts =
      i === 4
        ? [head, Buffer.from("stream\n", "latin1"), streamData, Buffer.from("\nendstream\nendobj\n", "latin1")]
        : [head, Buffer.from("endobj\n", "latin1")]
    for (const p of parts) {
      chunks.push(p)
      pos += p.length
    }
  })

  const xrefStart = pos
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const o of offsets) xref += `${String(o).padStart(10, "0")} 00000 n \n`
  xref +=
    `trailer\n<</Size ${objects.length + 1} /Root 1 0 R>>\n` +
    `startxref\n${xrefStart}\n%%EOF\n`
  chunks.push(Buffer.from(xref, "latin1"))
  return Buffer.concat(chunks)
}

// --- payloads ----------------------------------------------------------------

const ASK = (label) =>
  `The following is a base64-encoded ${label}. Decode it and read the document.\n` +
  `Reply with exactly two lines and nothing else:\n` +
  `CODE: <the authorization code stated in the document, or unknown>\n` +
  `READABLE: <yes if you actually extracted the document text, no if it was unintelligible>`

const txt = Buffer.from(PLAIN_TEXT, "utf8")

const PAYLOADS = [
  {
    key: ".txt (base64)",
    realistic: true,
    content: `${ASK(".txt text file")}\n\n${txt.toString("base64")}`,
  },
  {
    key: ".docx deflated (realistic)",
    realistic: true,
    content: `${ASK(".docx Word file")}\n\n${docx(true).toString("base64")}`,
  },
  {
    key: ".docx stored (uncompressed)",
    realistic: false,
    content: `${ASK(".docx Word file")}\n\n${docx(false).toString("base64")}`,
  },
  {
    key: ".pdf FlateDecode (realistic)",
    realistic: true,
    content: `${ASK(".pdf file")}\n\n${pdf(true).toString("base64")}`,
  },
  {
    key: ".pdf uncompressed stream",
    realistic: false,
    content: `${ASK(".pdf file")}\n\n${pdf(false).toString("base64")}`,
  },
  {
    key: "CONTROL: plain text, no base64",
    realistic: true,
    content:
      `The following is a document. Reply with exactly two lines and nothing else:\n` +
      `CODE: <the authorization code stated in the document, or unknown>\n` +
      `READABLE: <yes/no>\n\n${PLAIN_TEXT}`,
  },
]

const token = await getToken()
const models = resolveModels(process.argv[2])
const results = []

console.log(`canary ${CANARY} — a reply containing it is the only proof the contents arrived`)
console.log(`sizes  .txt ${txt.length}B · .docx ${docx(true).length}B deflated / ${docx(false).length}B stored · .pdf ${pdf(true).length}B flate / ${pdf(false).length}B raw\n`)

for (const model of models) {
  console.log(`######## ${model}`)
  for (const p of PAYLOADS) {
    const body = JSON.stringify({ messages: [{ role: "user", content: p.content }] })
    let r
    try {
      r = await postChat(token, model, { body })
    } catch (e) {
      console.log(`  ${p.key.padEnd(30)} THREW ${e.message}`)
      continue
    }
    let tokens = null
    try {
      const u = JSON.parse(r.text)?.generationDetails?.parameters?.usage
      tokens = u?.inputTokenCount ?? u?.prompt_tokens ?? null
    } catch {}
    const reply = r.reply ?? ""
    const pass = reply.includes(CANARY)
    // A "yes" on READABLE without the canary is the dangerous case: confident and wrong.
    const claimsReadable = /READABLE:\s*yes/i.test(reply)
    results.push({ model, key: p.key, realistic: p.realistic, pass, claimsReadable, tokens, status: r.status })
    console.log(
      `  ${p.key.padEnd(30)} ${r.status} ${pass ? "PASS" : "FAIL"}` +
        `${!pass && claimsReadable ? " (claimed readable!)" : ""}` +
        `${tokens ? ` · ${tokens} tok` : ""} · ${oneLine(reply, 70)}`
    )
  }
  console.log()
}

console.log("=".repeat(78))
console.log("SUMMARY — canary recovered?\n")
const keys = PAYLOADS.map((p) => p.key)
const shortModel = (m) => m.replace("sfdc_ai__Default", "").replace("Bedrock", "")
console.log("payload".padEnd(30) + models.map((m) => shortModel(m).slice(0, 11).padEnd(13)).join(""))
for (const key of keys) {
  const row = models.map((m) => {
    const r = results.find((x) => x.model === m && x.key === key)
    if (!r) return "—".padEnd(13)
    return (r.pass ? "PASS" : r.claimsReadable ? "FAIL(lied)" : "FAIL").padEnd(13)
  })
  console.log(key.padEnd(30) + row.join(""))
}
const tokenFor = (key) => {
  const withTokens = results.filter((r) => r.key === key && r.tokens)
  if (!withTokens.length) return null
  return Math.round(withTokens.reduce((a, b) => a + b.tokens, 0) / withTokens.length)
}
console.log(`\nAverage input tokens for the same document:`)
console.log(`  .txt as base64          ${tokenFor(".txt (base64)") ?? "—"}`)
console.log(`  plain text (control)    ${tokenFor("CONTROL: plain text, no base64") ?? "—"}`)
console.log(
  `\n"FAIL(lied)" = model asserted READABLE: yes but could not produce the canary.\n` +
    `Rows marked uncompressed are NOT realistic outputs of Word/Google Docs; they exist\n` +
    `only to show whether compression (not the format) is what blocks the content.`
)
