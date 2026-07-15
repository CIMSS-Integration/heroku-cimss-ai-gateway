/** A single chat message, matching the Salesforce Models API `messages` schema. */
export type ChatRole = "system" | "user" | "assistant"

export type ChatMessage = {
  role: ChatRole
  content: string
}

/**
 * A stored/displayed message. `model` is the Models API model id that produced
 * an assistant message; null for user turns and for backfilled assistant turns
 * whose original model is unknown. Kept separate from `ChatMessage` so the
 * wire format sent to the Salesforce Models API stays clean (role + content).
 */
export type ChatMessageWithModel = ChatMessage & {
  model: string | null
}

/** Sidebar-facing summary of a saved chat — no message bodies. */
export type ChatSessionSummary = {
  id: string
  model: string
  title: string | null
  updatedAt: string
}
