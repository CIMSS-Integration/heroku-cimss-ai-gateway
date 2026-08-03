/**
 * Model configuration for the Salesforce Models API chat.
 *
 * `id` MUST be the exact Salesforce Models API model name — the value that goes
 * into the endpoint path:
 *   POST {instanceUrl}/einstein/platform/v1/models/{id}/chat-generations
 *
 * Add or remove models here as they are enabled in your org. Only models listed
 * here are selectable in the UI and accepted by the /api/chat route.
 *
 * Find available model names in Setup → Einstein → Models API, or the docs:
 * https://developer.salesforce.com/docs/einstein/genai/guide/access-models-api-with-rest.html
 */

export type ModelConfig = {
  /** Exact Salesforce Models API model name (used in the endpoint path). */
  id: string
  /** Friendly name shown in the model picker. */
  label: string
  /** Optional one-line description shown under the picker. */
  description?: string
  /**
   * Approximate input context window in tokens. Used to decide when a chat is
   * getting close to the limit (see CONTEXT_WARN_RATIO) and shown in the picker.
   *
   * This is the real token window and it is what governs how much conversation a
   * chat can hold. Note it is a SEPARATE constraint from
   * PLATFORM_PROMPT_CHAR_LIMIT: that one is a character limit on any single
   * prompt, so a request can be well inside this window and still be rejected for
   * length. The two do not convert into one another.
   */
  contextWindow: number
  /**
   * Per-family tokenizer calibration for the structural token estimate in
   * `config/attachments.ts`, anchored at **prose** density; that file then adjusts
   * upward for symbol-dense text (see DENSITY_SENSITIVITY).
   *
   * Measured 2026-07-30 against the real API, comparing our structural estimate
   * to Salesforce's reported `inputTokenCount` on the same prose sample:
   *   - Claude Opus 4.8:   17,820 estimated → 19,335 actual → 1.085
   *   - Gemini 3.5 Flash:  17,820 estimated →  9,715 actual → 0.545
   * i.e. identical text costs ~2x more tokens on Claude than on Gemini (3.39 vs
   * 6.75 chars per token). No single constant can serve both, which is why this
   * is per-model rather than a shared chars-per-token figure.
   *
   * Values below 1 mean "cheaper than the structural estimate". An unmeasured model
   * inherits the factor measured for its own tokenizer family (all Anthropic models
   * share Claude's 1.09, all Gemini models share 0.55). A model belonging to no
   * measured family carries the highest measured value as a deliberately
   * conservative placeholder — over-estimating only warns early, whereas
   * under-estimating produces a hard platform rejection with no warning at all.
   */
  tokenFactor: number
}

export const MODELS: ModelConfig[] = [
  // --- 1M-token context window ---
  {
    id: "sfdc_ai__DefaultGPT55",
    label: "OpenAI GPT 5.5",
    description: "OpenAI GPT-5.5",
    contextWindow: 1_000_000,
    tokenFactor: 1.09, // UNMEASURED, no measured family — highest measured value
  },
  {
    id: "sfdc_ai__DefaultVertexAIGemini31FlashLite",
    label: "Gemini 3.1 Flash Lite",
    description: "Fastest, lowest-cost Google Gemini, via Vertex AI",
    contextWindow: 1_000_000,
    tokenFactor: 0.55, // same Gemini tokenizer family as 3.5 Flash
  },
  {
    id: "sfdc_ai__DefaultVertexAIGeminiPro31",
    label: "Gemini 3.1 Pro",
    description: "Google Gemini 3.1 Pro, via Vertex AI",
    contextWindow: 1_000_000,
    tokenFactor: 0.55, // same Gemini tokenizer family as 3.5 Flash
  },
  {
    id: "sfdc_ai__DefaultVertexAIGemini35Flash",
    label: "Gemini 3.5 Flash",
    description: "Google Gemini 3.5 Flash, via Vertex AI",
    contextWindow: 1_000_000,
    tokenFactor: 0.55, // measured 0.545 on prose — Gemini is ~2x cheaper here
  },
  // --- 64K-token context window (Einstein Trust Layer ceiling) ---
  {
    id: "sfdc_ai__DefaultBedrockAnthropicClaude48Opus",
    label: "Claude Opus 4.8",
    description:
      "Anthropic Claude Opus via Amazon Bedrock — 64K context with Trust Layer",
    contextWindow: 64_000,
    tokenFactor: 1.09, // measured 1.085 on prose (Anthropic tokenizer)
  },
  {
    id: "sfdc_ai__DefaultBedrockAnthropicClaude5Sonnet",
    label: "Claude Sonnet 5",
    description:
      "Anthropic Claude Sonnet via Amazon Bedrock — 64K context with Trust Layer",
    contextWindow: 64_000,
    tokenFactor: 1.09, // same Anthropic tokenizer family as Opus
  },
  {
    id: "sfdc_ai__DefaultBedrockAnthropicClaude45Haiku",
    label: "Claude Haiku 4.5",
    description:
      "Fast, low-cost Anthropic Claude Haiku via Amazon Bedrock — 64K context with Trust Layer",
    contextWindow: 64_000,
    tokenFactor: 1.09, // same Anthropic tokenizer family as Opus
  },
]

/**
 * Ceiling the Salesforce platform puts on a single prompt when Einstein Trust
 * Layer **PII detection** is enabled on the org. Rejected in ~0.1s, before model
 * dispatch, with:
 *
 *   400 BAD_ARGUMENT / E30036
 *   "Prompt size exceeds the token limit for when PII is enabled."
 *
 * **It is a CHARACTER limit, not a token limit — the error message misleads.**
 * Measured 2026-07-30 against `mimit.my.salesforce.com` with two very different
 * text types, which is what settles it:
 *
 *   SQL   458,000 chars = 162,512 tokens -> 200
 *   SQL   462,000 chars = ~163,900       -> 400
 *   prose 459,000 chars =  68,155 tokens -> 200
 *   prose 900,000 chars = ~133,000       -> 400   <-- kills the token theory
 *
 * Prose at 900k chars carries only ~133k tokens, far below any token cap, and
 * still fails; prose and SQL flip at the same *character* count despite a 2.4x
 * difference in tokens per character. An earlier revision of this file put the cap
 * at 163,840 tokens — that was an artifact of measuring with SQL alone, which
 * happens to tokenize at ~2.8 chars/token.
 *
 * Uniform across every model tested — Opus 4.8, Gemini 3.5 Flash, GPT-5.5, and
 * Nemotron Super 3.1 all fail at the same boundary. In particular **GPT-5.5 is not
 * exempt**, despite the supported-models doc implying it lacks Trust Layer
 * coverage. Consistent with the guard living in the platform gateway ahead of
 * model dispatch, as the 0.1s rejection latency also suggests.
 *
 * Set below the observed boundary (459,000 passed / 462,000 failed) for margin.
 * Unresolved: whether the true limit counts content characters or the serialized
 * JSON body, which newline escaping makes larger. Both fit every data point, and
 * guarding on content length with margin covers either.
 *
 * An ORG SETTING, not an API constant: the same payload that 400s in production
 * returned 200 with 458,916 input tokens against `mimit--full.sandbox`, which has
 * no such cap. The org handles PHI, so PII detection being on in production is
 * very likely deliberate — treat lifting it as a compliance decision, not a
 * performance tweak.
 *
 * NOT currently enforced client-side; it documents the failure mode behind the
 * `pii_prompt_cap` response in app/api/chat/route.ts.
 */
export const PLATFORM_PROMPT_CHAR_LIMIT = 440_000

/** Fallback window for a model that somehow lacks one configured. */
export const DEFAULT_CONTEXT_WINDOW = 128_000

/** Context window as a short display string: 1_000_000 → "1M", 200_000 → "200K". */
export function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`
  }
  return `${Math.round(tokens / 1_000)}K`
}

/** Per-family tokenizer calibration for the estimate in `config/attachments.ts`. */
export function tokenFactorFor(modelId: string | null): number {
  const model = MODELS.find((m) => m.id === modelId)
  // Unknown model: assume the most expensive family we've measured (Anthropic,
  // 1.085) rather than the cheapest, so an unrecognised id errs toward warning
  // early instead of toward a silent hard rejection.
  return model?.tokenFactor ?? 1.09
}

/**
 * Label for the model picker — "Claude Opus 4.8 (64K)". The window is derived
 * from `contextWindow` rather than written into `label`, so the number shown can't
 * drift from the value the context checks use. If a label already ends in a
 * parenthetical the window folds into it ("… (Bedrock · 1M)") instead of adding a
 * second pair of brackets.
 *
 * Shows each model's own effective window, which really does differ between them:
 * 1M on GPT 5.5 and the Gemini models, 64K on the Bedrock Claude models as served
 * through the Einstein Trust Layer. A previous revision substituted a single "160K"
 * for every model, on the theory that PLATFORM_PROMPT_CHAR_LIMIT was a token cap
 * binding below every window. That was wrong on both counts: the platform limit is
 * on characters, not tokens, so it cannot be expressed as a token window at all,
 * and collapsing every model to one number erased a real difference.
 */
export function pickerLabel(model: ModelConfig): string {
  const window = formatContextWindow(model.contextWindow)
  return model.label.endsWith(")")
    ? `${model.label.slice(0, -1)} · ${window})`
    : `${model.label} (${window})`
}

/** Look up a model's context window (tokens), falling back to the default. */
export function contextWindowFor(modelId: string | null): number {
  const model = MODELS.find((m) => m.id === modelId)
  return model?.contextWindow ?? DEFAULT_CONTEXT_WINDOW
}

/**
 * A model id that is safe to send to the Models API, falling back to
 * DEFAULT_MODEL when the given one isn't in MODELS.
 *
 * Needed because a chat's model is *persisted*, so stored rows outlive the config:
 * removing a model from MODELS leaves existing `ai.chat_session.model` values
 * pointing at it. As of 2026-07-30 the single most common stored value —
 * `sfdc_ai__DefaultBedrockAnthropicClaude46Sonnet`, 32 sessions — is one the org no
 * longer has enabled. Passing it through gets the whole request rejected by
 * Salesforce, which surfaced as AI-rename and Summarize failing on exactly the
 * oldest, longest chats.
 *
 * Chatting was never affected: the client already ignores an unknown stored model
 * (app/page.tsx) and sends a valid one. This closes the same gap on the two
 * server-side paths that read the stored value directly.
 *
 * Use it for the context-window budget as well as the call itself — sizing a
 * prompt against one model and sending it to another is how a budget silently
 * stops matching the limit it exists to respect.
 */
export function resolveModel(modelId: string | null | undefined): string {
  return MODELS.some((m) => m.id === modelId)
    ? (modelId as string)
    : DEFAULT_MODEL
}

/**
 * Fraction of the context window at which we offer to summarize. At/above this
 * (measured against the last turn's actual input-token count) the UI shows the
 * "summarize & continue / start new chat" prompt.
 */
export const CONTEXT_WARN_RATIO = 0.85

/**
 * How many of the most recent messages stay verbatim when summarizing; the
 * older ones are condensed into a synopsis.
 */
export const KEEP_RECENT_MESSAGES = 4

/**
 * The model selected by default when the app loads. Pinned by id, not by list
 * position, so reordering the picker above doesn't silently change the default
 * — and looked up in MODELS so it can never be a model /api/chat would reject.
 * If the id is ever dropped from MODELS, the first entry takes over.
 */
export const DEFAULT_MODEL =
  MODELS.find((m) => m.id === "sfdc_ai__DefaultBedrockAnthropicClaude5Sonnet")
    ?.id ??
  MODELS[0]?.id ??
  ""

/**
 * Time budget for a single Models API generation before we abort it and return
 * a clean 504.
 *
 * This must stay *below* whatever the fronting proxy allows, so that we respond
 * ourselves rather than letting the proxy kill the request with its own HTML
 * error page — leaving a margin to actually send the timeout response.
 *
 * On EC2 behind nginx that ceiling is ours to set: `proxy_read_timeout` in
 * `deploy/nginx-sfchat.conf` is 600s, so 540s here leaves a 60s margin. (The
 * old value was 28s, sized for Heroku's fixed 30s router timeout / H12 — the
 * limit this deployment exists to escape. Raise the nginx value first if you
 * ever raise this one.)
 */
export const GENERATION_TIMEOUT_MS = 540_000

/**
 * Time budget for an auto-title generation (first-message titling and AI
 * rename). Deliberately far shorter than a full reply: titles are a few tokens,
 * and for the first-message case the title call runs concurrently with the main
 * reply, so a runaway title must not hold up a reply that is already done.
 * Being generous here buys nothing — a title that takes 30s is a failed title.
 */
export const TITLE_TIMEOUT_MS = 30_000

/**
 * Optional system prompt prepended to every conversation. Set to "" to disable.
 * The Models API accepts a message with role "system".
 */
export const SYSTEM_PROMPT =
  "You are a helpful assistant. Answer clearly and concisely. " +
  "Use Markdown formatting. Always wrap code, commands, and file contents in " +
  "fenced code blocks (triple backticks) with a language tag, e.g. ```python — " +
  "never present code as plain text or with ad-hoc separators."
