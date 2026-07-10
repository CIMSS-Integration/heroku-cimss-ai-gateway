import { NextResponse } from "next/server"
import { auth } from "@clerk/nextjs/server"
import { chatGenerate } from "@/lib/salesforce"
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

  const { model, messages } = (payload ?? {}) as {
    model?: unknown
    messages?: unknown
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

  try {
    const { content } = await chatGenerate(model, messages as ChatMessage[])
    return NextResponse.json({ content })
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unexpected server error"
    console.error("[/api/chat]", message)
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
