import { NextResponse } from "next/server"
import { auth } from "@clerk/nextjs/server"
import {
  chatGenerateWithTimeout,
  generateChatTitle,
  GenerationTimeoutError,
  type ChatUsage,
} from "@/lib/salesforce"
import {
  createSession,
  appendConversation,
  getProjectInstructions,
  getSessionContext,
} from "@/lib/chat-store"
import { getSalesforceUsername } from "@/lib/identity"
import { MODELS, GENERATION_TIMEOUT_MS, TITLE_TIMEOUT_MS } from "@/config/models"
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

/**
 * Builds the messages actually sent to the model. Folds the base system prompt,
 * any project instructions, and (when the chat has been compacted) a summary of
 * the earlier conversation into a single leading system message — the Models API
 * expects at most one system turn. When a summary is present the leading
 * `summarizedCount` conversation messages it replaces are dropped, keeping only
 * the recent turns verbatim; at least the latest message is always kept.
 */
function buildModelMessages(
  messages: ChatMessage[],
  opts: {
    projectInstructions: string | null
    summary: string | null
    summarizedCount: number
  }
): ChatMessage[] {
  const conversation = messages.filter((m) => m.role !== "system")
  const baseSystem = messages.find((m) => m.role === "system")?.content ?? ""

  const parts: string[] = []
  if (baseSystem.trim()) parts.push(baseSystem.trim())
  if (opts.projectInstructions?.trim()) {
    parts.push(`Project instructions:\n${opts.projectInstructions.trim()}`)
  }
  if (opts.summary?.trim()) {
    parts.push(
      "Summary of earlier conversation (earlier messages were condensed to " +
        `save space; treat this as prior context):\n${opts.summary.trim()}`
    )
  }
  const systemContent = parts.join("\n\n")

  let tail = conversation
  if (opts.summary?.trim()) {
    const start = Math.max(
      0,
      Math.min(opts.summarizedCount, conversation.length - 1)
    )
    tail = conversation.slice(start)
  }

  // The Models API (Bedrock/Anthropic) expects the first non-system turn to be
  // from the user. Our slice normally lands on a user turn (history is
  // even-length and alternating, and KEEP_RECENT_MESSAGES is even), but drop any
  // leading assistant turn defensively so the payload never starts mid-exchange.
  while (tail.length > 1 && tail[0].role === "assistant") {
    tail = tail.slice(1)
  }

  return systemContent
    ? [{ role: "system", content: systemContent }, ...tail]
    : tail
}

/**
 * Heuristic: does a Salesforce error look like a context/token-limit rejection?
 * The Models API doesn't return a stable machine code for this, so we match the
 * usual phrasings. Used to surface the "summarize / new chat" prompt instead of
 * a raw error.
 */
function isContextLimitError(message: string): boolean {
  return /context (length|window)|maximum context|too many tokens|token limit|exceeds? the maximum|input is too long|prompt is too long|reduce the (length|number of tokens)|max(imum)?[ _-]?tokens/i.test(
    message
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

  const { model, messages, sessionId, projectId } = (payload ?? {}) as {
    model?: unknown
    messages?: unknown
    sessionId?: unknown
    projectId?: unknown
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

  // Only used when starting a NEW chat inside a project. Existing chats keep
  // whatever project they were already filed under (moves go via PATCH).
  if (projectId != null && typeof projectId !== "string") {
    return NextResponse.json(
      { error: "`projectId` must be a string if provided." },
      { status: 400 }
    )
  }
  const newChatProjectId = (projectId ?? null) as string | null

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

  // Assemble the context that shapes the model payload: project instructions
  // (project-wide guidance) and, for an already-compacted chat, the summary that
  // replaces its earlier turns. For an existing chat both come from the stored
  // session; for a brand-new chat only project instructions apply. Never fatal —
  // on any lookup error we proceed with what we have.
  let projectInstructions: string | null = null
  let summary: string | null = null
  let summarizedCount = 0

  // For an existing chat, enforce visibility + creator-only writes BEFORE we
  // spend a model call: a chat you can't see → 404; a shared (public-project)
  // chat you didn't create → 403 (view-only). A transient lookup error is
  // non-fatal — `appendConversation`'s creator-scoped row lock is the backstop,
  // so a hiccup never blocks a legitimate owner (nor lets a non-owner persist).
  if (activeSessionIdInput) {
    let ctx: Awaited<ReturnType<typeof getSessionContext>> | undefined
    try {
      ctx = await getSessionContext(activeSessionIdInput, sfUsername)
    } catch (err) {
      console.error("[/api/chat] session context lookup failed", err)
    }
    if (ctx === null) {
      return NextResponse.json({ error: "Chat not found" }, { status: 404 })
    }
    if (ctx && !ctx.isOwner) {
      return NextResponse.json(
        {
          error:
            "This is a shared chat — only its creator can add messages. Start your own chat in the project to contribute.",
          code: "read_only",
        },
        { status: 403 }
      )
    }
    if (ctx) {
      projectInstructions = ctx.projectInstructions
      summary = ctx.summary
      summarizedCount = ctx.summarizedCount
    }
  } else if (newChatProjectId) {
    try {
      projectInstructions = await getProjectInstructions(
        newChatProjectId,
        sfUsername
      )
    } catch (err) {
      console.error("[/api/chat] project instructions lookup failed", err)
    }
  }
  const messagesForModel = buildModelMessages(typedMessages, {
    projectInstructions,
    summary,
    summarizedCount,
  })

  // FR2: for a brand-new chat, generate its title CONCURRENTLY with the main
  // reply (from the user's message alone), rather than chaining a second model
  // call after it. Chaining two ≤28s calls could push the request past Heroku's
  // 30s router timeout (H12) and lose the reply; running them in parallel keeps
  // the total ≈ max(), and the short TITLE_TIMEOUT_MS bounds a slow title so it
  // can't hold up a fast reply. Best-effort — resolves null on failure/timeout,
  // and createSession falls back to the message-derived title.
  const firstUserMessage = conversation[0]?.content ?? ""
  const titlePromise: Promise<string | null> | null = activeSessionIdInput
    ? null
    : generateChatTitle(model, firstUserMessage, TITLE_TIMEOUT_MS)

  let content: string
  let usage: ChatUsage | null = null
  try {
    const result = await chatGenerateWithTimeout(
      model,
      messagesForModel,
      GENERATION_TIMEOUT_MS
    )
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
    // Timed out before Heroku's router limit — return a clean 504 (not the
    // platform's HTML H12) and, because this is before the persistence step,
    // the half-finished turn is never saved.
    if (error instanceof GenerationTimeoutError) {
      console.error("[/api/chat] model call timed out", error.timeoutMs)
      return NextResponse.json(
        {
          error:
            "The model took too long to respond and the request timed out. Try a shorter prompt or a faster model.",
          code: "timeout",
        },
        { status: 504 }
      )
    }
    const message =
      error instanceof Error ? error.message : "Unexpected server error"
    console.error("[/api/chat] model call failed", message)
    // Surface a context-limit rejection with a machine code so the client can
    // offer to summarize instead of showing a raw error.
    if (isContextLimitError(message)) {
      return NextResponse.json(
        {
          error:
            "This chat has reached the model's context limit. Summarize it to continue, or start a new chat.",
          code: "context_limit",
        },
        { status: 413 }
      )
    }
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
      // The AI title was kicked off in parallel with the reply (see above);
      // await whatever it produced. createSession falls back to a
      // message-derived title when it's null.
      const aiTitle = titlePromise ? await titlePromise : null
      activeSessionId = await createSession(
        sfUsername,
        model,
        conversation[0]?.content ?? content,
        newChatProjectId,
        aiTitle
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

  // Return the turn's input-token count so the client can measure how full the
  // context window is and offer to summarize as it approaches the limit.
  return NextResponse.json({
    content,
    sessionId: activeSessionId,
    usage: usage
      ? {
          inputTokenCount: usage.inputTokenCount,
          totalTokenCount: usage.totalTokenCount,
          outputTokenCount: usage.outputTokenCount,
        }
      : null,
  })
}
