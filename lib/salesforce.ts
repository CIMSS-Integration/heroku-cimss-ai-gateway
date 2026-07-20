import "server-only"
import type { ChatMessage } from "./types"

/**
 * Server-side client for the Salesforce Models API.
 *
 * Credentials never leave the server. The browser talks only to /api/chat,
 * which calls into this module.
 *
 * Auth: OAuth 2.0 client credentials flow.
 *   POST {SF_LOGIN_URL}/services/oauth2/token
 * Chat:
 *   POST {SF_API_HOST}/einstein/platform/v1/models/{model}/chat-generations
 *
 * Note: the token is obtained from your org (My Domain), but the Models API
 * itself is served from a dedicated host (https://api.salesforce.com), NOT the
 * org instance URL. That host is configurable via SF_API_HOST.
 */

// Models API REST host — the same for all orgs; overridable via env.
const DEFAULT_API_HOST = "https://api.salesforce.com"

type TokenCache = {
  accessToken: string
  fetchedAt: number
}

// Cached in module scope. In dev, Next.js may reset this on hot reload — fine,
// it just triggers a fresh token request.
let tokenCache: TokenCache | null = null

// Refresh comfortably before the org's session timeout (default ~2h).
const TOKEN_TTL_MS = 90 * 60 * 1000

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(
      `Missing environment variable ${name}. Set it in .env.local (see .env.example).`
    )
  }
  return value
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "")
}

async function fetchToken(): Promise<TokenCache> {
  const loginUrl = trimSlash(requireEnv("SF_LOGIN_URL"))
  const clientId = requireEnv("SF_CLIENT_ID")
  const clientSecret = requireEnv("SF_CLIENT_SECRET")

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
  })

  const res = await fetch(`${loginUrl}/services/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    cache: "no-store",
  })

  const text = await res.text()
  if (!res.ok) {
    throw new Error(`Salesforce token request failed (${res.status}): ${text}`)
  }

  let data: { access_token?: string; instance_url?: string }
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error(`Salesforce token response was not JSON: ${text}`)
  }

  if (!data.access_token) {
    throw new Error(`Salesforce token response missing access_token: ${text}`)
  }

  tokenCache = {
    accessToken: data.access_token,
    fetchedAt: Date.now(),
  }
  return tokenCache
}

async function getToken(forceRefresh = false): Promise<TokenCache> {
  if (
    !forceRefresh &&
    tokenCache &&
    Date.now() - tokenCache.fetchedAt < TOKEN_TTL_MS
  ) {
    return tokenCache
  }
  return fetchToken()
}

/** Token accounting returned by chat-generations, under
 *  generationDetails.parameters. All counts are optional — older/other models
 *  may omit some fields. */
export type ChatUsage = {
  inputTokenCount?: number
  outputTokenCount?: number
  totalTokenCount?: number
  cacheWriteInputTokenCount?: number
  cacheReadInputTokenCount?: number
  model?: string
}

export type ChatGenerateResult = {
  content: string
  usage: ChatUsage | null
  raw: unknown
}

/**
 * Send a full conversation (system/user/assistant turns) to the Models API
 * chat-generations endpoint and return the assistant's reply text.
 *
 * Pass `opts.signal` to bound the call (e.g. an AbortController that fires
 * before Heroku's router timeout). When it aborts, the underlying fetch throws
 * an AbortError, which callers can detect to return a clean timeout response.
 */
export async function chatGenerate(
  model: string,
  messages: ChatMessage[],
  opts: { signal?: AbortSignal } = {}
): Promise<ChatGenerateResult> {
  const apiHost = trimSlash(process.env.SF_API_HOST || DEFAULT_API_HOST)

  const call = (token: TokenCache) =>
    fetch(
      `${apiHost}/einstein/platform/v1/models/${encodeURIComponent(
        model
      )}/chat-generations`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token.accessToken}`,
          "Content-Type": "application/json",
          "x-sfdc-app-context": "EinsteinGPT",
          "x-client-feature-id": "ai-platform-models-connected-app",
        },
        body: JSON.stringify({ messages }),
        cache: "no-store",
        signal: opts.signal,
      }
    )

  let token = await getToken()
  let res = await call(token)

  // Token expired / revoked: refresh once and retry.
  if (res.status === 401) {
    token = await getToken(true)
    res = await call(token)
  }

  const text = await res.text()
  if (!res.ok) {
    throw new Error(
      `Salesforce chat-generations failed (${res.status}) for model "${model}": ${text}`
    )
  }

  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error(`Salesforce chat response was not JSON: ${text}`)
  }

  return { content: extractContent(data), usage: extractUsage(data), raw: data }
}

/** Thrown by chatGenerateWithTimeout when a call exceeds its time budget. */
export class GenerationTimeoutError extends Error {
  readonly timeoutMs: number
  constructor(timeoutMs: number) {
    super(`Model call exceeded ${timeoutMs}ms`)
    this.name = "GenerationTimeoutError"
    this.timeoutMs = timeoutMs
  }
}

/**
 * chatGenerate bounded by a timeout. Aborts the underlying request after
 * `timeoutMs` and throws GenerationTimeoutError — distinct from a real API
 * failure — so callers can return a clean 504 before Heroku's H12 fires.
 */
export async function chatGenerateWithTimeout(
  model: string,
  messages: ChatMessage[],
  timeoutMs: number
): Promise<ChatGenerateResult> {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  try {
    return await chatGenerate(model, messages, { signal: controller.signal })
  } catch (err) {
    if (timedOut || (err instanceof Error && err.name === "AbortError")) {
      throw new GenerationTimeoutError(timeoutMs)
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Pull the token-usage accounting out of the Models API response. The
 * chat-generations response nests it under generationDetails.parameters
 * ({ usage: {...}, model }); we defensively check a couple of known shapes.
 */
function extractUsage(data: unknown): ChatUsage | null {
  const d = data as {
    generationDetails?: { parameters?: Record<string, unknown> }
    parameters?: Record<string, unknown>
  }
  const params = d?.generationDetails?.parameters ?? d?.parameters
  if (!params) return null

  const usage = (params.usage ?? {}) as Record<string, unknown>
  const num = (v: unknown): number | undefined =>
    typeof v === "number" ? v : undefined

  return {
    inputTokenCount: num(usage.inputTokenCount),
    outputTokenCount: num(usage.outputTokenCount),
    totalTokenCount: num(usage.totalTokenCount),
    cacheWriteInputTokenCount: num(usage.cacheWriteInputTokenCount),
    cacheReadInputTokenCount: num(usage.cacheReadInputTokenCount),
    model: typeof params.model === "string" ? params.model : undefined,
  }
}

/**
 * Pull the assistant text out of the Models API response. The chat-generations
 * response nests the reply under generationDetails.generations[].content;
 * we defensively check a couple of known shapes.
 */
function extractContent(data: unknown): string {
  const d = data as {
    generationDetails?: {
      generations?: Array<{ content?: string; text?: string }>
    }
    generation?: { generatedText?: string; content?: string }
  }

  const gen = d?.generationDetails?.generations?.[0]
  if (gen?.content) return gen.content
  if (gen?.text) return gen.text
  if (d?.generation?.generatedText) return d.generation.generatedText
  if (d?.generation?.content) return d.generation.content

  return ""
}
