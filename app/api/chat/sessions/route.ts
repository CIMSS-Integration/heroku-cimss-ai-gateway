import { NextResponse } from "next/server"
import { auth } from "@clerk/nextjs/server"
import { listSessions } from "@/lib/chat-store"
import { getSalesforceUsername } from "@/lib/identity"

// Same rationale as app/api/chat/route.ts — pg needs the Node runtime.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** Lists the signed-in user's chats, most recently active first, for the sidebar. */
export async function GET() {
  const { userId } = await auth()
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const sfUsername = await getSalesforceUsername()
    // No linked Salesforce account → no chats to show, not an error.
    const sessions = sfUsername ? await listSessions(sfUsername) : []
    return NextResponse.json({ sessions })
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unexpected server error"
    console.error("[/api/chat/sessions]", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
