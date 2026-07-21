import "server-only"
import { pool } from "./db"
import type {
  ChatMessageWithModel,
  ChatProjectSummary,
  ChatProjectWithChats,
  ChatRole,
  ChatSessionSummary,
} from "./types"

export type { ChatSessionSummary, ChatProjectSummary, ChatProjectWithChats }

const PROJECT_NAME_MAX_LENGTH = 80

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
    `select role, content, model, metadata from ai.chat_message where session_id = $1 order by seq asc`,
    [sessionId]
  )
  return result.rows.map((row) => ({
    role: row.role as ChatRole,
    content: row.content as string,
    model: (row.model as string | null) ?? null,
    metadata: (row.metadata as Record<string, unknown> | null) ?? null,
  }))
}

function toSessionSummary(
  row: {
    id: string
    model: string
    title: string | null
    updated_at: Date
    project_id: string | null
    sf_username?: string
  },
  viewer?: string
): ChatSessionSummary {
  const base: ChatSessionSummary = {
    id: row.id,
    model: row.model,
    title: row.title,
    updatedAt: row.updated_at.toISOString(),
    projectId: row.project_id ?? null,
  }
  // Ownership/creator are only surfaced when the caller selected sf_username
  // (i.e. lists that can contain other users' chats, like a public project).
  // For a user's own lists we omit them — the chat is implicitly theirs.
  if (row.sf_username !== undefined) {
    base.creator = row.sf_username
    base.isOwner = row.sf_username === viewer
  }
  return base
}

/**
 * A user's non-archived, *unfiled* chats (not in any project), most recently
 * active first — powers the sidebar's "Chats" tab. Chats filed under a project
 * are listed by `getProject` instead.
 */
export async function listSessions(
  sfUsername: string
): Promise<ChatSessionSummary[]> {
  const result = await pool.query(
    `select id, model, title, updated_at, project_id
     from ai.chat_session
     where sf_username = $1 and archived_at is null and project_id is null
     order by updated_at desc`,
    [sfUsername]
  )
  return result.rows.map((row) => toSessionSummary(row))
}

/**
 * A single session's messages. Visible to its owner, or to anyone when the chat
 * is filed under a **public** project (view-only). The returned summary carries
 * `isOwner` so the client knows whether to allow writing; a non-owner viewing a
 * public-project chat gets `isOwner: false` and renders it read-only.
 */
export async function getSession(
  sessionId: string,
  sfUsername: string
): Promise<ChatSessionWithMessages | null> {
  const result = await pool.query(
    `select s.id, s.model, s.title, s.updated_at, s.project_id, s.sf_username
     from ai.chat_session s
     left join ai.chat_project p
       on p.id = s.project_id and p.archived_at is null
     where s.id = $1 and s.archived_at is null
       and (s.sf_username = $2 or p.is_public = true)`,
    [sessionId, sfUsername]
  )
  const session = result.rows[0]
  if (!session) return null

  return {
    ...toSessionSummary(session, sfUsername),
    messages: await getMessages(session.id),
  }
}

/**
 * Lightweight access check for a session: is it visible to this user, and do
 * they own it? Used by the write paths (`/api/chat`, session PATCH/DELETE) to
 * return a clean 403 (visible but not yours → view-only) vs 404 (not visible),
 * without loading the whole conversation. Returns null when not visible.
 */
export async function getSessionAccess(
  sessionId: string,
  sfUsername: string
): Promise<{ isOwner: boolean } | null> {
  const result = await pool.query(
    `select s.sf_username, (p.is_public = true) as project_public
     from ai.chat_session s
     left join ai.chat_project p
       on p.id = s.project_id and p.archived_at is null
     where s.id = $1 and s.archived_at is null`,
    [sessionId, sfUsername]
  )
  const row = result.rows[0]
  if (!row) return null
  const isOwner = row.sf_username === sfUsername
  const visible = isOwner || row.project_public === true
  return visible ? { isOwner } : null
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

/**
 * Renames a session. Scoped to its owner so one user can't rename another's
 * chat. The title is normalized/truncated the same way auto-titles are, so a
 * manual rename can never exceed what the column already stores. `updated_at`
 * is deliberately left untouched — renaming shouldn't reorder the sidebar.
 *
 * Returns the stored title (so the client reflects any truncation), or null if
 * the session doesn't exist / isn't owned by this user.
 */
export async function renameSession(
  sessionId: string,
  sfUsername: string,
  title: string
): Promise<string | null> {
  const finalTitle = deriveTitle(title)
  if (!finalTitle) return null

  const result = await pool.query(
    `update ai.chat_session
     set title = $3
     where id = $1 and sf_username = $2 and archived_at is null
     returning title`,
    [sessionId, sfUsername, finalTitle]
  )
  const row = result.rows[0]
  return row ? (row.title as string) : null
}

/**
 * Creates a new session, titled from the first user message. When `projectId`
 * is given the chat is filed under that project; ownership of the project is
 * verified (a foreign/unknown project id throws rather than silently filing
 * the chat nowhere).
 */
export async function createSession(
  sfUsername: string,
  model: string,
  firstUserMessage: string,
  projectId?: string | null,
  title?: string | null
): Promise<string> {
  if (projectId) {
    // Any user may file a chat under a project they can see: their own, or a
    // public one (they become that chat's creator either way).
    const visible = await pool.query(
      `select 1 from ai.chat_project
       where id = $1 and archived_at is null
         and (sf_username = $2 or is_public = true)`,
      [projectId, sfUsername]
    )
    if (visible.rowCount === 0) {
      throw new Error(`Project ${projectId} not found for this user`)
    }
  }

  // Prefer an explicit (e.g. AI-generated) title when given; otherwise derive
  // one from the first user message. deriveTitle normalizes/truncates either.
  const finalTitle = deriveTitle(title?.trim() ? title : firstUserMessage)

  const result = await pool.query(
    `insert into ai.chat_session (sf_username, model, title, project_id)
     values ($1, $2, $3, $4)
     returning id`,
    [sfUsername, model, finalTitle, projectId ?? null]
  )
  return result.rows[0].id as string
}

// ─── Projects ────────────────────────────────────────────────────────────────

function deriveProjectName(name: string): string {
  const trimmed = name.trim().replace(/\s+/g, " ")
  return trimmed.length > PROJECT_NAME_MAX_LENGTH
    ? `${trimmed.slice(0, PROJECT_NAME_MAX_LENGTH)}…`
    : trimmed
}

/**
 * Projects visible to a user — their own **plus** every public project — most
 * recently active first, with chat counts. `isOwner`/`isPublic` let the client
 * split the list into "your projects" and "public projects" and gate manage
 * actions. Chat counts include all members' chats for a public project.
 */
export async function listProjects(
  sfUsername: string
): Promise<ChatProjectSummary[]> {
  const result = await pool.query(
    `select p.id, p.name, p.updated_at, p.is_public, p.sf_username,
            count(s.id) filter (where s.archived_at is null) as chat_count
     from ai.chat_project p
     left join ai.chat_session s on s.project_id = p.id
     where p.archived_at is null and (p.sf_username = $1 or p.is_public = true)
     group by p.id
     order by p.updated_at desc`,
    [sfUsername]
  )
  return result.rows.map((row) => ({
    id: row.id as string,
    name: row.name as string,
    updatedAt: (row.updated_at as Date).toISOString(),
    chatCount: Number(row.chat_count),
    isPublic: row.is_public === true,
    isOwner: row.sf_username === sfUsername,
    owner: row.sf_username as string,
  }))
}

/**
 * Creates a project. `isPublic` makes it shared (visible to everyone,
 * view-only for non-creators). Returns null if the name is empty after
 * normalization.
 */
export async function createProject(
  sfUsername: string,
  name: string,
  instructions?: string | null,
  isPublic = false
): Promise<ChatProjectSummary | null> {
  const finalName = deriveProjectName(name)
  if (!finalName) return null

  const result = await pool.query(
    `insert into ai.chat_project (sf_username, name, instructions, is_public)
     values ($1, $2, $3, $4)
     returning id, name, updated_at, is_public`,
    [sfUsername, finalName, instructions?.trim() || null, isPublic]
  )
  const row = result.rows[0]
  return {
    id: row.id as string,
    name: row.name as string,
    updatedAt: (row.updated_at as Date).toISOString(),
    chatCount: 0,
    isPublic: row.is_public === true,
    isOwner: true,
    owner: sfUsername,
  }
}

/**
 * A single project plus its non-archived chats. Visible to its owner or, when
 * public, to anyone. For a public project ALL members' chats are returned, each
 * carrying `isOwner`/`creator` so the client can badge them and gate actions.
 */
export async function getProject(
  projectId: string,
  sfUsername: string
): Promise<ChatProjectWithChats | null> {
  const projectResult = await pool.query(
    `select id, name, instructions, updated_at, is_public, sf_username
     from ai.chat_project
     where id = $1 and archived_at is null
       and (sf_username = $2 or is_public = true)`,
    [projectId, sfUsername]
  )
  const project = projectResult.rows[0]
  if (!project) return null

  const chatsResult = await pool.query(
    `select id, model, title, updated_at, project_id, sf_username
     from ai.chat_session
     where project_id = $1 and archived_at is null
     order by updated_at desc`,
    [projectId]
  )
  const chats = chatsResult.rows.map((row) => toSessionSummary(row, sfUsername))

  return {
    id: project.id as string,
    name: project.name as string,
    updatedAt: (project.updated_at as Date).toISOString(),
    instructions: (project.instructions as string | null) ?? null,
    chatCount: chats.length,
    isPublic: project.is_public === true,
    isOwner: project.sf_username === sfUsername,
    owner: project.sf_username as string,
    chats,
  }
}

/**
 * Updates a project's name, instructions, and/or public-sharing flag. Scoped to
 * its owner (creator-only — the route additionally 403s non-owners). Each field
 * is only touched when provided. Returns the stored name (reflecting
 * normalization/truncation), or null if the project doesn't exist / isn't owned.
 */
export async function updateProject(
  projectId: string,
  sfUsername: string,
  fields: { name?: string; instructions?: string | null; isPublic?: boolean }
): Promise<string | null> {
  const finalName =
    fields.name !== undefined ? deriveProjectName(fields.name) : undefined
  if (fields.name !== undefined && !finalName) return null

  const client = await pool.connect()
  try {
    await client.query("begin")
    const result = await client.query(
      `update ai.chat_project
       set name = coalesce($3, name),
           instructions = case when $4::boolean then $5 else instructions end,
           is_public = case when $6::boolean then $7 else is_public end,
           updated_at = now()
       where id = $1 and sf_username = $2 and archived_at is null
       returning name`,
      [
        projectId,
        sfUsername,
        finalName ?? null,
        fields.instructions !== undefined,
        fields.instructions !== undefined
          ? (fields.instructions?.trim() || null)
          : null,
        fields.isPublic !== undefined,
        fields.isPublic ?? false,
      ]
    )
    const row = result.rows[0]
    if (!row) {
      await client.query("rollback")
      return null
    }

    // Making a project private: return every OTHER user's chats in it to their
    // own unfiled lists, atomically. Otherwise those chats would stay filed
    // under a project their owner can no longer see — stranded and unreachable
    // (mirrors archiveProject's orphaning; the owner's own chats stay filed).
    // Setting it to false when already private is a harmless no-op.
    if (fields.isPublic === false) {
      await client.query(
        `update ai.chat_session set project_id = null
         where project_id = $1 and sf_username <> $2`,
        [projectId, sfUsername]
      )
    }

    await client.query("commit")
    return row.name as string
  } catch (err) {
    await client.query("rollback")
    throw err
  } finally {
    client.release()
  }
}

/**
 * Soft-deletes a project. Its chats are orphaned back to "unfiled"
 * (project_id → null) rather than deleted, so no conversation is lost. Runs in
 * a transaction. Returns false if the project doesn't exist / isn't owned.
 */
export async function archiveProject(
  projectId: string,
  sfUsername: string
): Promise<boolean> {
  const client = await pool.connect()
  try {
    await client.query("begin")
    const archived = await client.query(
      `update ai.chat_project
       set archived_at = now()
       where id = $1 and sf_username = $2 and archived_at is null`,
      [projectId, sfUsername]
    )
    if (archived.rowCount === 0) {
      await client.query("rollback")
      return false
    }
    // Orphan EVERY chat in the project back to unfiled — including other users'
    // chats in a public project — so none is left pointing at an archived
    // project. Each lands in its own creator's unfiled list; nothing is deleted.
    await client.query(
      `update ai.chat_session set project_id = null where project_id = $1`,
      [projectId]
    )
    await client.query("commit")
    return true
  } catch (err) {
    await client.query("rollback")
    throw err
  } finally {
    client.release()
  }
}

/**
 * Files a chat under a project (or unfiles it when `projectId` is null). Both
 * the chat and, when filing, the target project must belong to this user.
 * Returns false if either ownership check fails.
 */
export async function moveSessionToProject(
  sessionId: string,
  sfUsername: string,
  projectId: string | null
): Promise<boolean> {
  if (projectId) {
    // Target may be the user's own project or any public one; you can file your
    // own chat into a shared project. (The chat itself stays owned by you — the
    // update below is still scoped to sf_username.)
    const visible = await pool.query(
      `select 1 from ai.chat_project
       where id = $1 and archived_at is null
         and (sf_username = $2 or is_public = true)`,
      [projectId, sfUsername]
    )
    if (visible.rowCount === 0) return false
  }

  const result = await pool.query(
    `update ai.chat_session set project_id = $3
     where id = $1 and sf_username = $2 and archived_at is null`,
    [sessionId, sfUsername, projectId]
  )
  return result.rowCount !== null && result.rowCount > 0
}

/** Everything /api/chat needs to build a session's model payload. */
export type SessionContext = {
  /** Project-wide instructions (via the session's project), or null. */
  projectInstructions: string | null
  /** Compaction summary of the earlier conversation, or null if not compacted. */
  summary: string | null
  /** How many leading conversation messages the summary replaces. */
  summarizedCount: number
  /** Whether the requester created this chat — only its creator may write to
   *  it, even when it's visible via a public project (view-only for others). */
  isOwner: boolean
}

/**
 * Reads the project instructions and compaction checkpoint for a session in one
 * query. Visible to the owner or, when the chat is in a public project, to
 * anyone (`isOwner` distinguishes the two). Returns null if the session doesn't
 * exist or isn't visible. Used by /api/chat to prepend project guidance, trim
 * compacted history, and enforce that only the creator may generate.
 */
export async function getSessionContext(
  sessionId: string,
  sfUsername: string
): Promise<SessionContext | null> {
  const result = await pool.query(
    `select s.metadata, s.sf_username, p.instructions as project_instructions
     from ai.chat_session s
     left join ai.chat_project p
       on p.id = s.project_id and p.archived_at is null
     where s.id = $1 and s.archived_at is null
       and (s.sf_username = $2 or p.is_public = true)`,
    [sessionId, sfUsername]
  )
  const row = result.rows[0]
  if (!row) return null

  const metadata = (row.metadata ?? {}) as {
    compaction?: { summary?: unknown; summarizedCount?: unknown }
  }
  const compaction = metadata.compaction ?? {}
  return {
    projectInstructions: (row.project_instructions as string | null) ?? null,
    summary: typeof compaction.summary === "string" ? compaction.summary : null,
    summarizedCount:
      typeof compaction.summarizedCount === "number"
        ? compaction.summarizedCount
        : 0,
    isOwner: row.sf_username === sfUsername,
  }
}

/** One entry in a session's compaction audit trail (metadata.compactionHistory). */
export type CompactionAudit = {
  /** ISO timestamp of the summarization. */
  at: string
  /** Model that produced the summary. */
  model: string
  /** Leading conversation messages the summary now replaces. */
  summarizedCount: number
  /** Recent messages kept verbatim. */
  keptRecent: number
  /** Oldest messages dropped from context because the history overflowed the
   *  summarizer's input budget (0 in the normal case). */
  droppedOldest: number
  /** Token usage of the summarization call, if the API reported it. */
  usage: {
    inputTokenCount?: number
    outputTokenCount?: number
    totalTokenCount?: number
  } | null
}

/**
 * Stores (or replaces) a session's compaction checkpoint in its jsonb metadata:
 * a summary of the earlier conversation plus how many leading messages it
 * covers. Also appends an audit entry to `metadata.compactionHistory` (an
 * append-only array) so every summarization is recorded for later inspection.
 * Deliberately does NOT bump `updated_at` — summarizing shouldn't reorder the
 * sidebar. Returns false if the session isn't owned by this user.
 */
export async function setSessionSummary(
  sessionId: string,
  sfUsername: string,
  summary: string,
  summarizedCount: number,
  audit: CompactionAudit
): Promise<boolean> {
  const result = await pool.query(
    `update ai.chat_session
     set metadata = coalesce(metadata, '{}'::jsonb)
       || jsonb_build_object(
            'compaction',
            jsonb_build_object('summary', $3::text, 'summarizedCount', $4::int)
          )
       || jsonb_build_object(
            'compactionHistory',
            coalesce(metadata -> 'compactionHistory', '[]'::jsonb) || $5::jsonb
          )
     where id = $1 and sf_username = $2 and archived_at is null`,
    [sessionId, sfUsername, summary, summarizedCount, JSON.stringify([audit])]
  )
  return result.rowCount !== null && result.rowCount > 0
}

/**
 * A project's instructions by id — visible to its owner or, when public, to
 * anyone (so a chat created in someone else's shared project still picks up its
 * guidance). Null if the project isn't visible / has no instructions.
 */
export async function getProjectInstructions(
  projectId: string,
  sfUsername: string
): Promise<string | null> {
  const result = await pool.query(
    `select instructions from ai.chat_project
     where id = $1 and archived_at is null
       and (sf_username = $2 or is_public = true)`,
    [projectId, sfUsername]
  )
  return (result.rows[0]?.instructions as string | null) ?? null
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
        `insert into ai.chat_message (session_id, role, content, seq, model, metadata)
         values ($1, $2, $3, $4, $5, $6::jsonb)`,
        [
          sessionId,
          message.role,
          message.content,
          seq,
          message.model,
          JSON.stringify(message.metadata ?? {}),
        ]
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
