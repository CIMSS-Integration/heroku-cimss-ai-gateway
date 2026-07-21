import { NextResponse } from "next/server"
import { auth } from "@clerk/nextjs/server"
import {
  chatGenerateWithTimeout,
  GenerationTimeoutError,
} from "@/lib/salesforce"
import { getSession, setSessionSummary } from "@/lib/chat-store"
import { getSalesforceUsername } from "@/lib/identity"
import {
  KEEP_RECENT_MESSAGES,
  GENERATION_TIMEOUT_MS,
  contextWindowFor,
} from "@/config/models"
import type { ChatMessage } from "@/lib/types"

// The Salesforce client uses Node APIs / env vars — force the Node runtime.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// Rough chars-per-token, used only to bound the summarizer's own input so it
// can't exceed the context window in the hard-limit case.
const CHARS_PER_TOKEN = 4

const SUMMARY_SYSTEM_PROMPT =
  "You are compacting a conversation so it fits within a token budget while " +
  "preserving continuity. Produce a concise but comprehensive summary of the " +
  "conversation below. Capture: key facts and data the user provided, " +
  "decisions made, any code or artifacts produced (keep essential snippets and " +
  "identifiers), the user's goals, and open questions or next steps. Use " +
  "compact note form. Do not add commentary or ask questions — output only the " +
  "summary."

/**
 * Compacts a chat: summarizes all but the most recent messages into a synopsis
 * stored on the session, so future turns send the summary + recent turns rather
 * than the whole history. Body: `{ sessionId: string }`.
 */
export async function POST(request: Request) {
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

  const { sessionId } = (payload ?? {}) as { sessionId?: unknown }
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    return NextResponse.json(
      { error: "`sessionId` must be a non-empty string." },
      { status: 400 }
    )
  }

  try {
    const sfUsername = await getSalesforceUsername()
    const session = sfUsername ? await getSession(sessionId, sfUsername) : null
    if (!session) {
      return NextResponse.json({ error: "Chat not found" }, { status: 404 })
    }
    // Compaction rewrites the chat's stored summary — a creator-only write.
    // A viewer of a shared (public-project) chat can see it but not compact it.
    if (session.isOwner === false) {
      return NextResponse.json(
        { error: "Only the chat's creator can summarize it." },
        { status: 403 }
      )
    }

    // Only user/assistant turns are stored, but filter defensively.
    const conversation = session.messages.filter((m) => m.role !== "system")
    if (conversation.length <= KEEP_RECENT_MESSAGES + 1) {
      // Not enough history to be worth compacting.
      return NextResponse.json({ summarized: false, reason: "too_short" })
    }

    const summarizedCount = conversation.length - KEEP_RECENT_MESSAGES
    const toSummarize = conversation.slice(0, summarizedCount)

    // Bound the summarizer's own input so this call can't itself exceed the
    // window (the hard-limit case, where the history is already too big — which
    // is exactly when a user reaches for "summarize"). We keep the most recent
    // summarizable messages that fit a fraction of the model's window and, if
    // the history overflows even that, drop the oldest from context entirely
    // (a sliding-window fallback) rather than 413-ing and leaving the chat
    // stuck. `summarizedCount` still marks the kept-verbatim boundary, so any
    // dropped-oldest messages simply fall out of context.
    const budgetChars = Math.max(
      4000,
      Math.floor(contextWindowFor(session.model) * CHARS_PER_TOKEN * 0.6)
    )
    const render = (m: (typeof toSummarize)[number]) =>
      `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`
    const kept: typeof toSummarize = []
    let used = 0
    let droppedOldest = 0
    for (let i = toSummarize.length - 1; i >= 0; i--) {
      const lineLen = render(toSummarize[i]).length + 2
      if (used + lineLen > budgetChars && kept.length > 0) {
        droppedOldest = i + 1
        break
      }
      kept.unshift(toSummarize[i])
      used += lineLen
    }
    if (droppedOldest > 0) {
      console.warn(
        `[/api/chat/summarize] history exceeds summarize budget; dropped ${droppedOldest} oldest message(s) from context`
      )
    }
    const transcript = kept.map(render).join("\n\n")

    const summaryMessages: ChatMessage[] = [
      { role: "system", content: SUMMARY_SYSTEM_PROMPT },
      {
        role: "user",
        content: `Conversation to summarize:\n\n${transcript}\n\n---\nWrite the summary now.`,
      },
    ]

    const { content: summary, usage } = await chatGenerateWithTimeout(
      session.model,
      summaryMessages,
      GENERATION_TIMEOUT_MS
    )
    if (!summary.trim()) {
      return NextResponse.json(
        { error: "The summary came back empty. Please try again." },
        { status: 502 }
      )
    }

    // Log the summarization's token accounting, mirroring /api/chat.
    console.log("[/api/chat/summarize] usage", {
      sessionId,
      model: session.model,
      summarizedCount,
      keptRecent: KEEP_RECENT_MESSAGES,
      droppedOldest,
      inputTokenCount: usage?.inputTokenCount,
      totalTokenCount: usage?.totalTokenCount,
      outputTokenCount: usage?.outputTokenCount,
    })

    const stored = await setSessionSummary(
      sessionId,
      sfUsername as string,
      summary,
      summarizedCount,
      {
        at: new Date().toISOString(),
        model: session.model,
        summarizedCount,
        keptRecent: KEEP_RECENT_MESSAGES,
        droppedOldest,
        usage: usage
          ? {
              inputTokenCount: usage.inputTokenCount,
              outputTokenCount: usage.outputTokenCount,
              totalTokenCount: usage.totalTokenCount,
            }
          : null,
      }
    )
    if (!stored) {
      return NextResponse.json({ error: "Chat not found" }, { status: 404 })
    }

    return NextResponse.json({
      summarized: true,
      summarizedCount,
      keptRecent: KEEP_RECENT_MESSAGES,
      droppedOldest,
    })
  } catch (error) {
    if (error instanceof GenerationTimeoutError) {
      console.error("[/api/chat/summarize] timed out", error.timeoutMs)
      return NextResponse.json(
        {
          error:
            "Summarizing took too long and timed out. Try again, or start a new chat.",
          code: "timeout",
        },
        { status: 504 }
      )
    }
    const message =
      error instanceof Error ? error.message : "Unexpected server error"
    console.error("[/api/chat/summarize] failed", message)
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
