import "server-only"
import { pool } from "./db"
import type { ChatMessage, ChatRole } from "./types"

export type ChatSessionWithMessages = {
  id: string
  model: string
  title: string | null
  messages: ChatMessage[]
}

const TITLE_MAX_LENGTH = 80

function deriveTitle(firstUserMessage: string): string {
  const trimmed = firstUserMessage.trim().replace(/\s+/g, " ")
  return trimmed.length > TITLE_MAX_LENGTH
    ? `${trimmed.slice(0, TITLE_MAX_LENGTH)}…`
    : trimmed
}

async function getMessages(sessionId: string): Promise<ChatMessage[]> {
  const result = await pool.query(
    `select role, content from ai.chat_message where session_id = $1 order by seq asc`,
    [sessionId]
  )
  return result.rows.map((row) => ({
    role: row.role as ChatRole,
    content: row.content as string,
  }))
}

/** Most recently active, non-archived session for a user — used to resume where they left off. */
export async function getLatestSession(
  sfUsername: string
): Promise<ChatSessionWithMessages | null> {
  const result = await pool.query(
    `select id, model, title
     from ai.chat_session
     where sf_username = $1 and archived_at is null
     order by updated_at desc
     limit 1`,
    [sfUsername]
  )
  const session = result.rows[0]
  if (!session) return null

  return {
    id: session.id as string,
    model: session.model as string,
    title: session.title as string | null,
    messages: await getMessages(session.id),
  }
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
 * Appends messages to a session on behalf of a user, continuing the seq
 * counter. Locks the session row for the duration of the transaction so
 * concurrent requests (e.g. two tabs) can't race on seq, and verifies the
 * session actually belongs to sfUsername before writing anything.
 */
export async function appendMessages(
  sessionId: string,
  sfUsername: string,
  messages: ChatMessage[]
): Promise<void> {
  if (messages.length === 0) return

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

    const seqResult = await client.query(
      `select coalesce(max(seq), 0) as max_seq from ai.chat_message where session_id = $1`,
      [sessionId]
    )
    let seq = seqResult.rows[0].max_seq as number

    for (const message of messages) {
      seq += 1
      await client.query(
        `insert into ai.chat_message (session_id, role, content, seq) values ($1, $2, $3, $4)`,
        [sessionId, message.role, message.content, seq]
      )
    }

    await client.query("commit")
  } catch (err) {
    await client.query("rollback")
    throw err
  } finally {
    client.release()
  }
}
