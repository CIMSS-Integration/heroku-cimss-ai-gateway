/**
 * Probe: which request-body shapes does chat-generations accept, and does any of
 * them carry an image?
 *
 * Sends a valid PNG in every plausible envelope — OpenAI-style `image_url`
 * parts, Anthropic-style `image`/`source` blocks, and an `attachments[]` field
 * on the message and at top level — and reports the status of each.
 *
 * Result as of 2026-07-28 (all 6 models): array-shaped `content` is rejected
 * `400 BAD_ARGUMENT` / `E30020` by the platform deserializer; `attachments[]`
 * returns `200` and is silently dropped. See docs/ARCHITECTURE.md, section
 * "Multimodal / file input is not possible on chat-generations".
 *
 * Usage:
 *   node scripts/probes/multimodal-payload-shapes.mjs                 # default model
 *   node scripts/probes/multimodal-payload-shapes.mjs all             # every model
 *   node scripts/probes/multimodal-payload-shapes.mjs <modelId> [A|B] # one model, one shape
 */
import {
  apiHost,
  getToken,
  loadEnv,
  oneLine,
  postChat,
  resolveModels,
  solidPng,
} from "./probe-lib.mjs"

loadEnv()

const PNG = solidPng(0x00, 0x33, 0xff) // solid blue
const B64 = PNG.toString("base64")
const DATA_URL = `data:image/png;base64,${B64}`
const Q = "What color is this image? Answer with one word."

const json = (obj) => ({ body: JSON.stringify(obj) })

const SHAPES = {
  "A: content string (baseline, no image)": () =>
    json({ messages: [{ role: "user", content: "Say OK." }] }),

  "B: content array, text part only": () =>
    json({ messages: [{ role: "user", content: [{ type: "text", text: "Say OK." }] }] }),

  "C: OpenAI-style image_url (data URL)": () =>
    json({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: Q },
            { type: "image_url", image_url: { url: DATA_URL } },
          ],
        },
      ],
    }),

  "D: Anthropic-style image source block": () =>
    json({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: Q },
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: B64 },
            },
          ],
        },
      ],
    }),

  "E: message.attachments[]": () =>
    json({
      messages: [
        { role: "user", content: Q, attachments: [{ mimeType: "image/png", data: B64 }] },
      ],
    }),

  "F: top-level attachments[]": () =>
    json({
      messages: [{ role: "user", content: Q }],
      attachments: [{ mimeType: "image/png", data: B64 }],
    }),
}

const models = resolveModels(process.argv[2])
const shapeFilter = process.argv[3] // optional leading letter, e.g. "C"

const token = await getToken()
console.log(`host ${apiHost()} · test png ${B64.length} base64 chars\n`)

for (const model of models) {
  console.log(`=== ${model}`)
  for (const [name, make] of Object.entries(SHAPES)) {
    if (shapeFilter && !name.startsWith(shapeFilter)) continue
    let r
    try {
      r = await postChat(token, model, make())
    } catch (err) {
      console.log(`  ${name}\n    THREW ${err.message}`)
      continue
    }
    console.log(
      `  ${name}\n    ${r.status} ${r.reply ? "reply:" : "body:"} ${oneLine(r.reply ?? r.text, 220)}`
    )
  }
  console.log()
}
