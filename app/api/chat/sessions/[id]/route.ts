import { NextResponse } from "next/server"
import { auth } from "@clerk/nextjs/server"
import { archiveSession, getSession } from "@/lib/chat-store"
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
