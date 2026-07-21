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
  /** The project this chat is filed under, or null when unfiled. */
  projectId: string | null
  /**
   * Whether the signed-in user created this chat. Only meaningful for chats
   * surfaced inside a public project (where other users' chats are visible);
   * omitted/true for a user's own lists. Drives whether manage actions and the
   * composer are enabled.
   */
  isOwner?: boolean
  /** Salesforce username of the chat's creator — shown as a badge in public
   *  projects so viewers can see whose chat it is. Null/omitted for own chats. */
  creator?: string | null
}

/** Sidebar-facing summary of a project (no chats). */
export type ChatProjectSummary = {
  id: string
  name: string
  updatedAt: string
  /** Count of non-archived chats filed under the project. */
  chatCount: number
  /** Shared with every user (view-only for non-creators) when true. */
  isPublic: boolean
  /** Whether the signed-in user created (and thus can manage) this project. */
  isOwner: boolean
  /** Creator's Salesforce username — shown for attribution on shared projects. */
  owner: string
}

/** A project plus the chats filed under it. */
export type ChatProjectWithChats = ChatProjectSummary & {
  /** Project-wide instructions prepended to the system prompt for its chats. */
  instructions: string | null
  chats: ChatSessionSummary[]
}
