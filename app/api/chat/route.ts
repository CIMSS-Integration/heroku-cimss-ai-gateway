import { NextResponse } from "next/server"
import { auth } from "@clerk/nextjs/server"
import { chatGenerate, type ChatUsage } from "@/lib/salesforce"
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

  // This app requires a linked Salesforce account: every chat is logged under a
  // Salesforce username, so we refuse to generate anything we couldn't attribute
  // and store. No SF account → 403, before the model is ever called (no gap).
  const sfUsername = await getSalesforceUsername()
  if (!sfUsername) {
    return NextResponse.json(
      {
        error:
          "This app requires a linked Salesforce account, which we couldn't find for your login.",
      },
      { status: 403 }
    )
  }

  const typedMessages = messages as ChatMessage[]
  // The full user/assistant conversation as the client currently holds it
  // (system turns are re-derived per request, never stored).
  const conversation = typedMessages.filter((m) => m.role !== "system")

  let content: string
  let usage: ChatUsage | null = null
  try {
    const result = await chatGenerate(model, typedMessages)
    content = result.content
    usage = result.usage
    // Log the Salesforce token accounting for each generation request.
    console.log("[/api/chat] generation usage", {
      sessionId: activeSessionIdInput ?? null,
      requestedModel: model,
      inputTokenCount: usage?.inputTokenCount,
      totalTokenCount: usage?.totalTokenCount,
      outputTokenCount: usage?.outputTokenCount,
      cacheWriteInputTokenCount: usage?.cacheWriteInputTokenCount,
      cacheReadInputTokenCount: usage?.cacheReadInputTokenCount,
      model: usage?.model,
    })
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unexpected server error"
    console.error("[/api/chat] model call failed", message)
    return NextResponse.json({ error: message }, { status: 502 })
  }

  // Token accounting to persist on the assistant turn (mirrors the shape of the
  // Salesforce response's `parameters`). Null when the API returned no usage.
  const assistantMetadata: Record<string, unknown> | null = usage
    ? {
        usage: {
          inputTokenCount: usage.inputTokenCount,
          outputTokenCount: usage.outputTokenCount,
          totalTokenCount: usage.totalTokenCount,
          cacheWriteInputTokenCount: usage.cacheWriteInputTokenCount,
          cacheReadInputTokenCount: usage.cacheReadInputTokenCount,
        },
        model: usage.model,
      }
    : null

  // The whole conversation plus the just-generated reply. Only the reply's
  // model is known here; earlier turns carry null (unknown/backfill). The
  // reply also carries its token usage in metadata.
  const fullConversation: ChatMessageWithModel[] = [
    ...conversation.map((m) => ({ ...m, model: null })),
    { role: "assistant" as ChatRole, content, model, metadata: assistantMetadata },
  ]

  // Persistence is on the critical path — we don't return a reply we failed to
  // log. On failure the client can retry; reconciliation backfills without
  // duplicating (matches on role+content prefix), so no gap and no dupe.
  let activeSessionId = activeSessionIdInput
  try {
    if (!activeSessionId) {
      activeSessionId = await createSession(
        sfUsername,
        model,
        conversation[0]?.content ?? content
      )
    }
    await appendConversation(activeSessionId, sfUsername, fullConversation, model)
  } catch (persistError) {
    console.error("[/api/chat] failed to persist chat turn", persistError)
    return NextResponse.json(
      {
        error:
          "Your message was answered but couldn't be saved. Please try again.",
      },
      { status: 500 }
    )
  }

  return NextResponse.json({ content, sessionId: activeSessionId })
}
