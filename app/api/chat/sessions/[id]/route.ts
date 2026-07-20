import { NextResponse } from "next/server"
import { auth } from "@clerk/nextjs/server"
import {
  archiveSession,
  getSession,
  moveSessionToProject,
  renameSession,
} from "@/lib/chat-store"
import { getSalesforceUsername } from "@/lib/identity"

// Same rationale as app/api/chat/route.ts — pg needs the Node runtime.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type RouteParams = { params: Promise<{ id: string }> }

/** Loads one chat's messages, e.g. when the user picks it from the sidebar. */
export async function GET(_request: Request, { params }: RouteParams) {
  const { userId } = await auth()
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const { id } = await params

  try {
    const sfUsername = await getSalesforceUsername()
    const session = sfUsername ? await getSession(id, sfUsername) : null
    if (!session) {
      return NextResponse.json({ error: "Chat not found" }, { status: 404 })
    }
    return NextResponse.json({ session })
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unexpected server error"
    console.error("[/api/chat/sessions/[id]] GET", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

/**
 * Updates a chat. Two independent operations, either or both per request:
 *   - rename: `{ title: string }`
 *   - move to/from a project: `{ projectId: string | null }` (null = unfile)
 */
export async function PATCH(request: Request, { params }: RouteParams) {
  const { userId } = await auth()
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const { id } = await params

  let payload: unknown
  try {
    payload = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const body = (payload ?? {}) as { title?: unknown; projectId?: unknown }
  const hasTitle = body.title !== undefined
  const hasProject = body.projectId !== undefined

  if (!hasTitle && !hasProject) {
    return NextResponse.json(
      { error: "Provide `title` and/or `projectId` to update." },
      { status: 400 }
    )
  }
  if (
    hasTitle &&
    (typeof body.title !== "string" || body.title.trim().length === 0)
  ) {
    return NextResponse.json(
      { error: "`title` must be a non-empty string." },
      { status: 400 }
    )
  }
  if (
    hasProject &&
    body.projectId !== null &&
    typeof body.projectId !== "string"
  ) {
    return NextResponse.json(
      { error: "`projectId` must be a string or null." },
      { status: 400 }
    )
  }

  try {
    const sfUsername = await getSalesforceUsername()
    if (!sfUsername) {
      return NextResponse.json({ error: "Chat not found" }, { status: 404 })
    }

    const response: { ok: true; title?: string } = { ok: true }

    if (hasProject) {
      const moved = await moveSessionToProject(
        id,
        sfUsername,
        body.projectId as string | null
      )
      if (!moved) {
        return NextResponse.json(
          { error: "Chat or target project not found" },
          { status: 404 }
        )
      }
    }

    if (hasTitle) {
      const newTitle = await renameSession(id, sfUsername, body.title as string)
      if (!newTitle) {
        return NextResponse.json({ error: "Chat not found" }, { status: 404 })
      }
      response.title = newTitle
    }

    return NextResponse.json(response)
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unexpected server error"
    console.error("[/api/chat/sessions/[id]] PATCH", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

/** Soft-deletes (archives) a chat from the sidebar. */
export async function DELETE(_request: Request, { params }: RouteParams) {
  const { userId } = await auth()
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const { id } = await params

  try {
    const sfUsername = await getSalesforceUsername()
    const deleted = sfUsername ? await archiveSession(id, sfUsername) : false
    if (!deleted) {
      return NextResponse.json({ error: "Chat not found" }, { status: 404 })
    }
    return NextResponse.json({ ok: true })
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unexpected server error"
    console.error("[/api/chat/sessions/[id]] DELETE", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
