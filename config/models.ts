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
    label: "Claude Sonnet (Bedrock)",
    description: "Anthropic Claude, served via Amazon Bedrock",
  },
  // --- Examples: uncomment/edit once confirmed enabled in your org ---
  // {
  //   id: "sfdc_ai__DefaultOpenAIGPT4OmniMini",
  //   label: "GPT-4o mini",
  //   description: "OpenAI GPT-4o mini",
  // },
  // {
  //   id: "sfdc_ai__DefaultBedrockAnthropicClaude3Haiku",
  //   label: "Claude 3 Haiku (Bedrock)",
  //   description: "Fast, low-cost Anthropic Claude 3 Haiku",
  // },
]

/** The model selected by default when the app loads. */
export const DEFAULT_MODEL = MODELS[0]?.id ?? ""

/**
 * Optional system prompt prepended to every conversation. Set to "" to disable.
 * The Models API accepts a message with role "system".
 */
export const SYSTEM_PROMPT =
  "You are a helpful assistant. Answer clearly and concisely."
