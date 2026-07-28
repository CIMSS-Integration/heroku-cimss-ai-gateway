/**
 * Probe: can an image reach the model by putting the binary *inside* the string
 * `content` (data URL / bare base64 / markdown image tag), or by sending the
 * request as multipart/form-data with the raw bytes?
 *
 * Both are 200-but-useless / hard-rejected respectively, and the first is the
 * dangerous one — the platform ignores unknown fields and never converts inline
 * base64 into an image part, so the model answers plausibly from nothing.
 *
 * Discriminating design: the same question is asked about two *different* solid
 * colors, plus a no-image control. If the pixels really arrived, the answer
 * tracks the color. If the answers don't track it — or match the control's blind
 * guess — nothing arrived, however confident the reply sounds.
 *
 * Result as of 2026-07-28 (all 6 models): 5 correct out of 36 trials, all 5 on
 * the green image, 0/18 on orange — guessing bias, not decoding. Most models
 * asserted SAW_IMAGE: yes while wrong. Multipart returns
 * `500 INTERNAL_ERROR` / `E00077` wrapping `HTTP 415 Unsupported Media Type`.
 * See docs/ARCHITECTURE.md, section "Multimodal / file input is not possible on
 * chat-generations".
 *
 * Usage:
 *   node scripts/probes/inline-binary.mjs             # default model
 *   node scripts/probes/inline-binary.mjs all         # every model
 *   node scripts/probes/inline-binary.mjs <modelId>
 */
import {
  getToken,
  loadEnv,
  oneLine,
  postChat,
  resolveModels,
  solidPng,
  userMessage,
} from "./probe-lib.mjs"

loadEnv()

// Two colors far apart in name-space, neither of them the usual blind guess.
const COLORS = [
  { name: "orange #FF7A00", png: solidPng(0xff, 0x7a, 0x00) },
  { name: "green  #1FA84C", png: solidPng(0x1f, 0xa8, 0x4c) },
]

// Asking the model to self-report whether it *saw* an image is what exposes the
// false-confidence failure: a wrong color plus "SAW_IMAGE: yes" is fabrication.
const ASK =
  "What color is this image? Reply with exactly two lines:\n" +
  "COLOR: <one word>\n" +
  "SAW_IMAGE: <yes if you can actually view it as an image, no if you only received text>"

/** multipart/form-data body carrying the raw PNG bytes beside a messages part. */
function multipart(png) {
  const boundary = "----sfprobe00000000"
  const head =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="messages"\r\n` +
    `Content-Type: application/json\r\n\r\n` +
    JSON.stringify([{ role: "user", content: ASK }]) +
    `\r\n--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="image.png"\r\n` +
    `Content-Type: image/png\r\n\r\n`
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    body: Buffer.concat([
      Buffer.from(head, "utf8"),
      png,
      Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"),
    ]),
  }
}

const VARIANTS = {
  "1 data URL inside content string": (png) => ({
    body: userMessage(`${ASK}\n\ndata:image/png;base64,${png.toString("base64")}`),
  }),
  "2 bare base64 inside content string": (png) => ({
    body: userMessage(`${ASK}\n\n${png.toString("base64")}`),
  }),
  "3 base64 in a markdown image tag": (png) => ({
    body: userMessage(`${ASK}\n\n![image](data:image/png;base64,${png.toString("base64")})`),
  }),
  "4 multipart/form-data, raw bytes": (png) => multipart(png),
}

const token = await getToken()

for (const model of resolveModels(process.argv[2])) {
  console.log(`######## ${model}\n`)

  // Control: no image data at all — establishes the model's blind guess, so a
  // "correct" answer below can be told apart from a lucky one.
  const control = await postChat(token, model, { body: userMessage(ASK) })
  console.log(`CONTROL (no image sent)\n  ${control.status} ${oneLine(control.reply ?? control.text)}\n`)

  for (const [name, make] of Object.entries(VARIANTS)) {
    console.log(name)
    for (const color of COLORS) {
      let r
      try {
        r = await postChat(token, model, make(color.png))
      } catch (err) {
        console.log(`  ${color.name} -> THREW ${err.message}`)
        continue
      }
      console.log(`  ${color.name} -> ${r.status} ${oneLine(r.reply ?? r.text)}`)
    }
    console.log()
  }
}
