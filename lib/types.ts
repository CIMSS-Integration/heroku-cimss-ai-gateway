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
  /**
   * Per-turn metadata stored in `ai.chat_message.metadata` (jsonb). For an
   * assistant turn this holds the Salesforce token accounting, e.g.
   * `{ usage: { inputTokenCount, outputTokenCount, totalTokenCount,
   * cacheWriteInputTokenCount, cacheReadInputTokenCount }, model }`. Absent for
   * user turns and for turns stored before usage tracking existed.
   */
  metadata?: Record<string, unknown> | null
}

/** Sidebar-facing summary of a saved chat — no message bodies. */
export type ChatSessionSummary = {
  id: string
  model: string
  title: string | null
  updatedAt: string
}
