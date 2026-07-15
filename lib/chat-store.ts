import "server-only"
import { pool } from "./db"
import type {
  ChatMessageWithModel,
  ChatRole,
  ChatSessionSummary,
} from "./types"

export type { ChatSessionSummary }

export type ChatSessionWithMessages = ChatSessionSummary & {
  messages: ChatMessageWithModel[]
}

const TITLE_MAX_LENGTH = 80

function deriveTitle(firstUserMessage: string): string {
  const trimmed = firstUserMessage.trim().replace(/\s+/g, " ")
  return trimmed.length > TITLE_MAX_LENGTH
    ? `${trimmed.slice(0, TITLE_MAX_LENGTH)}…`
    : trimmed
}

async function getMessages(
  sessionId: string
): Promise<ChatMessageWithModel[]> {
  const result = await pool.query(
    `select role, content, model from ai.chat_message where session_id = $1 order by seq asc`,
    [sessionId]
  )
  return result.rows.map((row) => ({
    role: row.role as ChatRole,
    content: row.content as string,
    model: (row.model as string | null) ?? null,
  }))
}

/** All of a user's non-archived sessions, most recently active first — powers the sidebar. */
export async function listSessions(
  sfUsername: string
): Promise<ChatSessionSummary[]> {
  const result = await pool.query(
    `select id, model, title, updated_at
     from ai.chat_session
     where sf_username = $1 and archived_at is null
     order by updated_at desc`,
    [sfUsername]
  )
  return result.rows.map((row) => ({
    id: row.id as string,
    model: row.model as string,
    title: row.title as string | null,
    updatedAt: (row.updated_at as Date).toISOString(),
  }))
}

/** A single session's messages, scoped to its owner so one user can't load another's chat. */
export async function getSession(
  sessionId: string,
  sfUsername: string
): Promise<ChatSessionWithMessages | null> {
  const result = await pool.query(
    `select id, model, title, updated_at
     from ai.chat_session
     where id = $1 and sf_username = $2 and archived_at is null`,
    [sessionId, sfUsername]
  )
  const session = result.rows[0]
  if (!session) return null

  return {
    id: session.id as string,
    model: session.model as string,
    title: session.title as string | null,
    updatedAt: (session.updated_at as Date).toISOString(),
    messages: await getMessages(session.id),
  }
}

/** Soft-deletes a session. Returns false if it doesn't exist / isn't owned by this user. */
export async function archiveSession(
  sessionId: string,
  sfUsername: string
): Promise<boolean> {
  const result = await pool.query(
    `update ai.chat_session
     set archived_at = now()
     where id = $1 and sf_username = $2 and archived_at is null`,
    [sessionId, sfUsername]
  )
  return result.rowCount !== null && result.rowCount > 0
}

/** Creates a new session, titled from the first user message. */
export async function createSession(
  sfUsername: string,
  model: string,
  firstUserMessage: string
): Promise<string> {
  const result = await pool.query(
    `insert into ai.chat_session (sf_username, model, title)
     values ($1, $2, $3)
     returning id`,
    [sfUsername, model, deriveTitle(firstUserMessage)]
  )
  return result.rows[0].id as string
}

/**
 * Reconciles a session's stored messages with the full conversation the client
 * currently holds, then records the newest model as the session's model.
 *
 * `conversation` is the entire user/assistant history as the client sees it,
 * ending with the just-generated assistant reply. Rather than blindly appending
 * the last turn (which permanently loses any earlier turn whose write was
 * skipped or failed — audit #1/#3), we compare against what's stored and insert
 * whatever is missing:
 *
 *  - If the stored rows are a clean prefix of `conversation` (the normal case,
 *    and the recover-a-skipped-turn case), we append everything past the prefix.
 *  - If they diverge (e.g. two tabs interleaving — audit #7), we never rewrite
 *    or drop existing rows; we only append the two genuinely-new trailing turns
 *    so nothing the user just did is lost.
 *
 * The session row is locked for the transaction so concurrent requests can't
 * race on `seq`, and ownership (sf_username, not archived) is verified before
 * any write.
 */
export async function appendConversation(
  sessionId: string,
  sfUsername: string,
  conversation: ChatMessageWithModel[],
  latestModel: string
): Promise<void> {
  if (conversation.length === 0) return

  const client = await pool.connect()
  try {
    await client.query("begin")

    const ownerResult = await client.query(
      `select 1 from ai.chat_session
       where id = $1 and sf_username = $2 and archived_at is null
       for update`,
      [sessionId, sfUsername]
    )
    if (ownerResult.rowCount === 0) {
      throw new Error(`Session ${sessionId} not found for this user`)
    }

    const existingResult = await client.query(
      `select role, content, seq from ai.chat_message
       where session_id = $1 order by seq asc`,
      [sessionId]
    )
    const existing = existingResult.rows as Array<{
      role: string
      content: string
      seq: number
    }>

    // How many stored rows form a clean prefix of the client's conversation?
    let prefix = 0
    while (
      prefix < existing.length &&
      prefix < conversation.length &&
      existing[prefix].role === conversation[prefix].role &&
      existing[prefix].content === conversation[prefix].content
    ) {
      prefix += 1
    }

    const toInsert =
      prefix === existing.length
        ? // Stored rows are a clean prefix — append everything after them
          // (covers the happy path and backfilling skipped earlier turns).
          conversation.slice(existing.length)
        : // Divergence — don't touch existing rows; append only the new pair.
          conversation.slice(-2)

    let seq =
      existing.length === 0 ? 0 : existing[existing.length - 1].seq

    for (const message of toInsert) {
      seq += 1
      await client.query(
        `insert into ai.chat_message (session_id, role, content, seq, model)
         values ($1, $2, $3, $4, $5)`,
        [sessionId, message.role, message.content, seq, message.model]
      )
    }

    // Record the model behind the newest reply so resume reflects the last
    // model used, not whichever produced the first reply (audit #4).
    await client.query(
      `update ai.chat_session set model = $2, updated_at = now() where id = $1`,
      [sessionId, latestModel]
    )

    await client.query("commit")
  } catch (err) {
    await client.query("rollback")
    throw err
  } finally {
    client.release()
  }
}
