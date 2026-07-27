import { NextResponse } from "next/server"
import { auth } from "@clerk/nextjs/server"
import { getUsageStats } from "@/lib/chat-store"
import { getSalesforceUsername } from "@/lib/identity"

// Same rationale as app/api/chat/route.ts — pg needs the Node runtime.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Org-wide usage stats: chats and messages per user, for the "Stats" tab in the
 * account menu. Open to every signed-in user with a linked Salesforce account —
 * the counts are considered shared information, unlike chat content, which no
 * route ever exposes across users.
 *
 * A linked Salesforce account is still required: without one the caller isn't a
 * user of this app (the chat UI is blocked for them), so they get a 403 rather
 * than the org's numbers.
 */
export async function GET() {
  const { userId } = await auth()
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const sfUsername = await getSalesforceUsername()
    if (!sfUsername) {
      return NextResponse.json(
        { error: "Requires a linked Salesforce account." },
        { status: 403 }
      )
    }

    const stats = await getUsageStats()
    return NextResponse.json({ stats })
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unexpected server error"
    console.error("[/api/chat/stats]", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
