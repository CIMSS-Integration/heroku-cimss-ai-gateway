import { NextResponse } from "next/server"
import { auth } from "@clerk/nextjs/server"
import { chatGenerate } from "@/lib/salesforce"
import { createSession, appendMessages } from "@/lib/chat-store"
import { getSalesforceUsername } from "@/lib/identity"
import { MODELS } from "@/config/models"
import type { ChatMessage, ChatRole } from "@/lib/types"

// The Salesforce client uses Node APIs / env vars — force the Node runtime.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const VALID_ROLES: ChatRole[] = ["system", "user", "assistant"]

function isValidMessage(m: unknown): m is ChatMessage {
  if (typeof m !== "object" || m === null) return false
  const msg = m as Record<string, unknown>
  return (
    typeof msg.content === "string" &&
    typeof msg.role === "string" &&
    VALID_ROLES.includes(msg.role as ChatRole)
  )
}

export async function POST(request: Request) {
  // Require an authenticated Clerk session before hitting the Models API.
  const { userId } = await auth()
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  let payload: unknown
  try {
    payload = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const { model, messages, sessionId } = (payload ?? {}) as {
    model?: unknown
    messages?: unknown
    sessionId?: unknown
  }

  if (typeof model !== "string" || !MODELS.some((m) => m.id === model)) {
    return NextResponse.json(
      { error: `Unknown or missing model. Configure it in config/models.ts.` },
      { status: 400 }
    )
  }

  if (!Array.isArray(messages) || messages.length === 0) {
    return NextResponse.json(
      { error: "`messages` must be a non-empty array." },
      { status: 400 }
    )
  }

  if (!messages.every(isValidMessage)) {
    return NextResponse.json(
      { error: "Each message must have a valid role and string content." },
      { status: 400 }
    )
  }

  // The client sends `null` (not just omitting the field) for a fresh chat —
  // JSON.stringify serializes a null useState value as literal `null`.
  if (sessionId != null && typeof sessionId !== "string") {
    return NextResponse.json(
      { error: "`sessionId` must be a string if provided." },
      { status: 400 }
    )
  }
  const activeSessionIdInput = (sessionId ?? undefined) as string | undefined

  const typedMessages = messages as ChatMessage[]
  // The client always sends the full history with the new user turn last —
  // that's the only message from this request we need to persist ourselves.
  const newestUserMessage = typedMessages[typedMessages.length - 1]

  try {
    const { content } = await chatGenerate(model, typedMessages)
    const assistantMessage: ChatMessage = { role: "assistant", content }

    let activeSessionId = activeSessionIdInput
    try {
      const sfUsername = await getSalesforceUsername()
      if (!sfUsername) {
        // No linked Salesforce account (SSO/metadata gap) — chat still
        // works, it just isn't persisted for this turn.
        console.error(
          `[/api/chat] no linked Salesforce account for Clerk user ${userId}; skipping persistence`
        )
      } else {
        if (!activeSessionId) {
          activeSessionId = await createSession(
            sfUsername,
            model,
            newestUserMessage.content
          )
        }
        await appendMessages(activeSessionId, sfUsername, [
          newestUserMessage,
          assistantMessage,
        ])
      }
    } catch (persistError) {
      // A storage hiccup shouldn't fail a chat turn the user is actively
      // waiting on — log it and let the response through unsaved.
      console.error("[/api/chat] failed to persist chat turn", persistError)
    }

    return NextResponse.json({ content, sessionId: activeSessionId })
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unexpected server error"
    console.error("[/api/chat]", message)
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
