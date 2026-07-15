import { NextResponse } from "next/server"
import { auth } from "@clerk/nextjs/server"
import { chatGenerate } from "@/lib/salesforce"
import { createSession, appendConversation } from "@/lib/chat-store"
import { getSalesforceUsername } from "@/lib/identity"
import { MODELS } from "@/config/models"
import type { ChatMessage, ChatMessageWithModel, ChatRole } from "@/lib/types"

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
  // The full user/assistant conversation as the client currently holds it
  // (system turns are re-derived per request, never stored).
  const conversation = typedMessages.filter((m) => m.role !== "system")

  try {
    const { content } = await chatGenerate(model, typedMessages)

    // The whole conversation plus the just-generated reply. Only the reply's
    // model is known here; earlier turns carry null (unknown/backfill).
    const fullConversation: ChatMessageWithModel[] = [
      ...conversation.map((m) => ({ ...m, model: null })),
      { role: "assistant" as ChatRole, content, model },
    ]

    let activeSessionId = activeSessionIdInput
    let persisted = false
    try {
      const sfUsername = await getSalesforceUsername()
      if (!sfUsername) {
        // No linked Salesforce account (SSO/metadata gap) — chat still
        // works, it just isn't persisted. Reported to the client so the UI
        // can warn instead of silently losing the conversation (audit #2).
        console.error(
          `[/api/chat] no linked Salesforce account for Clerk user ${userId}; skipping persistence`
        )
      } else {
        if (!activeSessionId) {
          activeSessionId = await createSession(
            sfUsername,
            model,
            conversation[0]?.content ?? content
          )
        }
        await appendConversation(
          activeSessionId,
          sfUsername,
          fullConversation,
          model
        )
        persisted = true
      }
    } catch (persistError) {
      // A storage hiccup shouldn't fail a chat turn the user is actively
      // waiting on — log it and let the response through, flagged unsaved.
      console.error("[/api/chat] failed to persist chat turn", persistError)
    }

    return NextResponse.json({
      content,
      sessionId: activeSessionId,
      persisted,
    })
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unexpected server error"
    console.error("[/api/chat]", message)
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
