import { NextResponse } from "next/server"
import { auth } from "@clerk/nextjs/server"
import { createProject, listProjects } from "@/lib/chat-store"
import { getSalesforceUsername } from "@/lib/identity"

// Same rationale as app/api/chat/route.ts — pg needs the Node runtime.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** Lists the signed-in user's projects, most recently active first. */
export async function GET() {
  const { userId } = await auth()
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const sfUsername = await getSalesforceUsername()
    const projects = sfUsername ? await listProjects(sfUsername) : []
    return NextResponse.json({ projects })
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unexpected server error"
    console.error("[/api/chat/projects] GET", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

/** Creates a project. Body: `{ name: string, instructions?: string }`. */
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

  const { name, instructions, isPublic } = (payload ?? {}) as {
    name?: unknown
    instructions?: unknown
    isPublic?: unknown
  }
  if (typeof name !== "string" || name.trim().length === 0) {
    return NextResponse.json(
      { error: "`name` must be a non-empty string." },
      { status: 400 }
    )
  }
  if (instructions !== undefined && typeof instructions !== "string") {
    return NextResponse.json(
      { error: "`instructions` must be a string if provided." },
      { status: 400 }
    )
  }
  if (isPublic !== undefined && typeof isPublic !== "boolean") {
    return NextResponse.json(
      { error: "`isPublic` must be a boolean if provided." },
      { status: 400 }
    )
  }

  try {
    const sfUsername = await getSalesforceUsername()
    if (!sfUsername) {
      return NextResponse.json(
        { error: "This app requires a linked Salesforce account." },
        { status: 403 }
      )
    }
    const project = await createProject(
      sfUsername,
      name,
      instructions ?? null,
      isPublic === true
    )
    if (!project) {
      return NextResponse.json(
        { error: "`name` must be a non-empty string." },
        { status: 400 }
      )
    }
    return NextResponse.json({ project }, { status: 201 })
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unexpected server error"
    console.error("[/api/chat/projects] POST", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
