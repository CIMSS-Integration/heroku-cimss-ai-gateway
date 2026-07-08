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
}

export const MODELS: ModelConfig[] = [
  {
    id: "sfdc_ai__DefaultBedrockAnthropicClaude46Sonnet",
    label: "Claude Sonnet 4.6 (Bedrock)",
    description: "Anthropic Claude Sonnet, served via Amazon Bedrock",
  },
  {
    id: "sfdc_ai__DefaultBedrockAnthropicClaude48Opus",
    label: "Claude Opus 4.8 (Bedrock)",
    description: "Anthropic Claude Opus, served via Amazon Bedrock",
  },
  {
    id: "sfdc_ai__DefaultBedrockAnthropicClaude45Haiku",
    label: "Claude Haiku 4.5 (Bedrock)",
    description: "Fast, low-cost Anthropic Claude Haiku, via Amazon Bedrock",
  },
  {
    id: "sfdc_ai__DefaultGPT55",
    label: "GPT-5.5 (OpenAI)",
    description: "OpenAI GPT-5.5",
  },
]

/** The model selected by default when the app loads. */
export const DEFAULT_MODEL = MODELS[0]?.id ?? ""

/**
 * Optional system prompt prepended to every conversation. Set to "" to disable.
 * The Models API accepts a message with role "system".
 */
export const SYSTEM_PROMPT =
  "You are a helpful assistant. Answer clearly and concisely."
