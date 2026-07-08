/** A single chat message, matching the Salesforce Models API `messages` schema. */
export type ChatRole = "system" | "user" | "assistant"

export type ChatMessage = {
  role: ChatRole
  content: string
}
