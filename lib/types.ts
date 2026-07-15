/** A single chat message, matching the Salesforce Models API `messages` schema. */
export type ChatRole = "system" | "user" | "assistant"

export type ChatMessage = {
  role: ChatRole
  content: string
}

/** Sidebar-facing summary of a saved chat — no message bodies. */
export type ChatSessionSummary = {
  id: string
  model: string
  title: string | null
  updatedAt: string
}
