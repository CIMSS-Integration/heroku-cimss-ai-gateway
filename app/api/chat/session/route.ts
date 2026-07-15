import { NextResponse } from "next/server"
import { auth } from "@clerk/nextjs/server"
import { getLatestSession } from "@/lib/chat-store"
import { getSalesforceUsername } from "@/lib/identity"

// Same rationale as app/api/chat/route.ts — pg needs the Node runtime.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** Returns the user's most recently active chat, if any, so the client can resume it. */
export async function GET() {
  const { userId } = await auth()
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const sfUsername = await getSalesforceUsername()
    // No linked Salesforce account → nothing to resume, not an error.
    const session = sfUsername ? await getLatestSession(sfUsername) : null
    return NextResponse.json({ session })
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unexpected server error"
    console.error("[/api/chat/session]", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
