/**
 * Shared helpers for the Models API probe scripts in this directory.
 *
 * Probes talk to the *real* Salesforce Models API using the org credentials in
 * `.env.local` — the same client-credentials flow as `lib/salesforce.ts`. They
 * are deliberately plain `.mjs` with no dependencies so they can be run with a
 * bare `node` against any checkout, without a build step or test runner.
 */
import fs from "node:fs"
import path from "node:path"
import zlib from "node:zlib"
import { fileURLToPath } from "node:url"

/** Repo root, resolved from this file's location (scripts/probes/). */
export const ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../..")

/**
 * Minimal .env parser — enough for KEY=value and quoted values. Existing
 * process.env wins, so `SF_API_HOST=... node probe.mjs` still overrides.
 */
export function loadEnv(file = ".env.local") {
  const full = path.join(ROOT, file)
  if (!fs.existsSync(full)) {
    throw new Error(`Missing ${file} at ${full} — copy .env.example and fill it in.`)
  }
  for (const line of fs.readFileSync(full, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!m) continue
    let v = m[2].trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1)
    }
    if (!process.env[m[1]]) process.env[m[1]] = v
  }
}

const trimSlash = (s) => s.replace(/\/+$/, "")

export const apiHost = () =>
  trimSlash(process.env.SF_API_HOST || "https://api.salesforce.com")

/**
 * The model ids the app actually offers, scraped out of config/models.ts so a
 * probe can never drift from the app's own list. Regex rather than an import
 * because that file is TypeScript and these scripts run under plain node.
 */
export function modelIds() {
  const src = fs.readFileSync(path.join(ROOT, "config/models.ts"), "utf8")
  return [...src.matchAll(/id:\s*"(sfdc_ai__[A-Za-z0-9]+)"/g)].map((m) => m[1])
}

/** OAuth 2.0 client-credentials token, same as lib/salesforce.ts. */
export async function getToken() {
  const loginUrl = trimSlash(process.env.SF_LOGIN_URL)
  const res = await fetch(`${loginUrl}/services/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: process.env.SF_CLIENT_ID,
      client_secret: process.env.SF_CLIENT_SECRET,
    }),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`token request failed (${res.status}): ${text}`)
  const token = JSON.parse(text).access_token
  if (!token) throw new Error(`token response had no access_token: ${text}`)
  return token
}

/**
 * POST to chat-generations. `body` is sent verbatim (string or Buffer) so a
 * probe can send a deliberately malformed/unusual payload; `contentType`
 * defaults to JSON. Pass `signal` to bound a slow request (large payloads can
 * take minutes) — an abort surfaces as an AbortError for the caller to label,
 * which is how a hang is told apart from a rejection. Returns the status, the
 * extracted reply if the response parsed as a normal generation, and the raw
 * body text.
 */
export async function postChat(token, model, { body, contentType = "application/json", signal }) {
  const res = await fetch(
    `${apiHost()}/einstein/platform/v1/models/${encodeURIComponent(model)}/chat-generations`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": contentType,
        "x-sfdc-app-context": "EinsteinGPT",
        "x-client-feature-id": "ai-platform-models-connected-app",
      },
      body,
      signal,
    }
  )
  const text = await res.text()
  let reply = null
  try {
    reply = JSON.parse(text)?.generationDetails?.generations?.[0]?.content ?? null
  } catch {
    /* non-JSON error body — callers fall back to `text` */
  }
  return { status: res.status, reply, text }
}

/** Convenience: a single user message with plain-string content. */
export const userMessage = (content) =>
  JSON.stringify({ messages: [{ role: "user", content }] })

/**
 * A genuinely valid solid-color PNG, built here (IHDR + deflated scanlines +
 * CRCs) rather than pasted as a base64 blob, so a rejection can never be
 * blamed on a malformed test file.
 */
export function solidPng(r, g, b, size = 32) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, "ascii"), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(zlib.crc32(body))
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // colour type 2 = truecolour RGB
  const raw = Buffer.concat(
    Array.from({ length: size }, () =>
      Buffer.concat([
        Buffer.from([0]), // per-scanline filter: none
        Buffer.concat(Array.from({ length: size }, () => Buffer.from([r, g, b]))),
      ])
    )
  )
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ])
}

/** Collapse a reply to one readable line for tabular console output. */
export const oneLine = (s, max = 160) =>
  (s ?? "").replace(/\s+/g, " ").trim().slice(0, max)

/**
 * Resolve which models to probe: an explicit id argument, `all` for every model
 * in config/models.ts, or the app's default model when nothing is passed.
 */
export function resolveModels(arg) {
  const all = modelIds()
  if (!arg) return [all[0]]
  if (arg === "all") return all
  return [arg]
}
