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
   * getting close to the limit (see CONTEXT_WARN_RATIO). These are the models'
   * advertised windows; if the Salesforce platform caps lower, the hard-error
   * fallback still catches it.
   */
  contextWindow: number
}

export const MODELS: ModelConfig[] = [
  {
    id: "sfdc_ai__DefaultBedrockAnthropicClaude48Opus",
    label: "Claude Opus 4.8 (Bedrock)",
    description: "Anthropic Claude Opus, served via Amazon Bedrock",
    contextWindow: 200_000,
  },
  {
    id: "sfdc_ai__DefaultBedrockAnthropicClaude46Sonnet",
    label: "Claude Sonnet 4.6 (Bedrock)",
    description: "Anthropic Claude Sonnet, served via Amazon Bedrock",
    contextWindow: 200_000,
  },
  {
    id: "sfdc_ai__DefaultBedrockAnthropicClaude45Haiku",
    label: "Claude Haiku 4.5 (Bedrock)",
    description: "Fast, low-cost Anthropic Claude Haiku, via Amazon Bedrock",
    contextWindow: 200_000,
  },
  {
    id: "sfdc_ai__DefaultGPT55",
    label: "GPT-5.5 (OpenAI)",
    description: "OpenAI GPT-5.5",
    contextWindow: 128_000,
  },
  {
    id: "sfdc_ai__DefaultBedrockNvidiaNemotronSuper3120b",
    label: "Nemotron Super 3.1 (Bedrock)",
    description: "NVIDIA Llama Nemotron Super 3.1 20B, via Amazon Bedrock",
    contextWindow: 128_000,
  },
  {
    id: "sfdc_ai__DefaultVertexAIGemini35Flash",
    label: "Gemini 3.5 Flash (Vertex AI)",
    description: "Google Gemini 3.5 Flash, via Vertex AI",
    contextWindow: 1_000_000,
  },
]

/** Fallback window for a model that somehow lacks one configured. */
export const DEFAULT_CONTEXT_WINDOW = 128_000

/** Look up a model's context window (tokens), falling back to the default. */
export function contextWindowFor(modelId: string | null): number {
  const model = MODELS.find((m) => m.id === modelId)
  return model?.contextWindow ?? DEFAULT_CONTEXT_WINDOW
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
  MODELS.find((m) => m.id === "sfdc_ai__DefaultBedrockAnthropicClaude48Opus")
    ?.id ??
  MODELS[0]?.id ??
  ""

/**
 * Time budget for a single Models API generation before we abort it and return
 * a clean 504. Kept just under Heroku's 30s router timeout (H12) so we respond
 * ourselves rather than letting the platform kill the request with an HTML error
 * page — leaving a small margin to actually send the timeout response.
 */
export const GENERATION_TIMEOUT_MS = 28_000

/**
 * Time budget for an auto-title generation (first-message titling and AI
 * rename). Shorter than a full reply: titles are a few tokens, and for the
 * first-message case the title call runs concurrently with the main reply, so a
 * runaway title must not extend the overall request toward Heroku's H12.
 */
export const TITLE_TIMEOUT_MS = 12_000

/**
 * Optional system prompt prepended to every conversation. Set to "" to disable.
 * The Models API accepts a message with role "system".
 */
export const SYSTEM_PROMPT =
  "You are a helpful assistant. Answer clearly and concisely. " +
  "Use Markdown formatting. Always wrap code, commands, and file contents in " +
  "fenced code blocks (triple backticks) with a language tag, e.g. ```python — " +
  "never present code as plain text or with ad-hoc separators."
