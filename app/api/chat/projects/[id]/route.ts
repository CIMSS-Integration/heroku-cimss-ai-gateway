import { NextResponse } from "next/server"
import { auth } from "@clerk/nextjs/server"
import {
  archiveProject,
  getProject,
  updateProject,
} from "@/lib/chat-store"
import { getSalesforceUsername } from "@/lib/identity"

// Same rationale as app/api/chat/route.ts — pg needs the Node runtime.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type RouteParams = { params: Promise<{ id: string }> }

/** Loads one project and the chats filed under it. */
export async function GET(_request: Request, { params }: RouteParams) {
  const { userId } = await auth()
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const { id } = await params

  try {
    const sfUsername = await getSalesforceUsername()
    const project = sfUsername ? await getProject(id, sfUsername) : null
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 })
    }
    return NextResponse.json({ project })
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unexpected server error"
    console.error("[/api/chat/projects/[id]] GET", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

/**
 * Updates a project's name and/or instructions.
 * Body: `{ name?: string, instructions?: string | null }`.
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

  const { name, instructions } = (payload ?? {}) as {
    name?: unknown
    instructions?: unknown
  }
  if (name !== undefined && (typeof name !== "string" || name.trim().length === 0)) {
    return NextResponse.json(
      { error: "`name` must be a non-empty string if provided." },
      { status: 400 }
    )
  }
  if (
    instructions !== undefined &&
    instructions !== null &&
    typeof instructions !== "string"
  ) {
    return NextResponse.json(
      { error: "`instructions` must be a string or null if provided." },
      { status: 400 }
    )
  }
  if (name === undefined && instructions === undefined) {
    return NextResponse.json(
      { error: "Provide `name` and/or `instructions` to update." },
      { status: 400 }
    )
  }

  try {
    const sfUsername = await getSalesforceUsername()
    if (!sfUsername) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 })
    }
    // Editing a project is creator-only. Distinguish "not visible" (404) from
    // "visible but not yours" (403) so a public project's viewers get a clear
    // signal rather than a misleading 404.
    const project = await getProject(id, sfUsername)
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 })
    }
    if (!project.isOwner) {
      return NextResponse.json(
        { error: "Only the project's creator can edit it." },
        { status: 403 }
      )
    }
    const newName = await updateProject(id, sfUsername, {
      name: name as string | undefined,
      instructions: instructions as string | null | undefined,
    })
    if (!newName) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 })
    }
    return NextResponse.json({ ok: true, name: newName })
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unexpected server error"
    console.error("[/api/chat/projects/[id]] PATCH", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

/** Archives a project; its chats are orphaned back to unfiled (not deleted). */
export async function DELETE(_request: Request, { params }: RouteParams) {
  const { userId } = await auth()
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const { id } = await params

  try {
    const sfUsername = await getSalesforceUsername()
    if (!sfUsername) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 })
    }
    // Deleting a project is creator-only (404 if not visible, 403 if visible
    // via public sharing but not owned).
    const project = await getProject(id, sfUsername)
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 })
    }
    if (!project.isOwner) {
      return NextResponse.json(
        { error: "Only the project's creator can delete it." },
        { status: 403 }
      )
    }
    const archived = await archiveProject(id, sfUsername)
    if (!archived) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 })
    }
    return NextResponse.json({ ok: true })
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unexpected server error"
    console.error("[/api/chat/projects/[id]] DELETE", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
