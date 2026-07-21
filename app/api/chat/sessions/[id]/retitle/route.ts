import { NextResponse } from "next/server"
import { auth } from "@clerk/nextjs/server"
import { generateChatTitle } from "@/lib/salesforce"
import { getSession, renameSession } from "@/lib/chat-store"
import { getSalesforceUsername } from "@/lib/identity"
import { TITLE_TIMEOUT_MS, contextWindowFor } from "@/config/models"

// The Salesforce client / pg need the Node runtime.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type RouteParams = { params: Promise<{ id: string }> }

// We send the WHOLE chat to the title model by default. Only if it's big enough
// to risk overflowing the model's context do we reduce — and then we keep the
// most RECENT messages (the title should reflect where the conversation ended
// up), not the opening. Rough chars-per-token; keep the transcript under half
// the model's window to leave room for the prompt + reply.
const CHARS_PER_TOKEN = 4
const RECENT_MESSAGES_FALLBACK = 4

/**
 * FR3: AI-rename a chat. Reads the whole conversation, asks the chat's
 * last-used model for a short (4–5 word) title, and renames the chat to it.
 * Creator-only (a public-project chat is visible to others but only its
 * creator can rename it).
 */
export async function POST(_request: Request, { params }: RouteParams) {
  const { userId } = await auth()
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const { id } = await params

  try {
    const sfUsername = await getSalesforceUsername()
    if (!sfUsername) {
      // Same distinct signal as the other mutating routes (see UAT rename bug).
      console.warn(
        "[/api/chat/sessions/[id]/retitle] Salesforce username unresolved for signed-in user"
      )
      return NextResponse.json(
        {
          error: "We couldn't verify your Salesforce account. Please try again.",
          code: "identity_unverified",
        },
        { status: 503 }
      )
    }

    const session = await getSession(id, sfUsername)
    if (!session) {
      return NextResponse.json({ error: "Chat not found" }, { status: 404 })
    }
    if (session.isOwner === false) {
      return NextResponse.json(
        { error: "Only the chat's creator can rename it." },
        { status: 403 }
      )
    }

    const conversation = session.messages.filter((m) => m.role !== "system")
    if (conversation.length === 0) {
      return NextResponse.json(
        { error: "This chat has no messages to name yet." },
        { status: 400 }
      )
    }

    const render = (m: (typeof conversation)[number]) =>
      `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`
    let transcript = conversation.map(render).join("\n\n")

    // Reduce only when the full transcript would risk overflowing the model;
    // then keep the last few messages rather than head-truncating.
    const budgetChars = Math.floor(
      contextWindowFor(session.model) * CHARS_PER_TOKEN * 0.5
    )
    if (transcript.length > budgetChars) {
      transcript = conversation
        .slice(-RECENT_MESSAGES_FALLBACK)
        .map(render)
        .join("\n\n")
    }

    const title = await generateChatTitle(
      session.model,
      transcript,
      TITLE_TIMEOUT_MS
    )
    if (!title) {
      return NextResponse.json(
        { error: "Couldn't generate a title. Please try again." },
        { status: 502 }
      )
    }

    const stored = await renameSession(id, sfUsername, title)
    if (!stored) {
      return NextResponse.json({ error: "Chat not found" }, { status: 404 })
    }
    return NextResponse.json({ ok: true, title: stored })
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unexpected server error"
    console.error("[/api/chat/sessions/[id]/retitle]", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
