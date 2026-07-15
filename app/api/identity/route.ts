import { NextResponse } from "next/server"
import { auth } from "@clerk/nextjs/server"
import { getSalesforceIdentity } from "@/lib/identity"

// currentUser() / pg use Node APIs — force the Node runtime.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Reports the signed-in user's Salesforce link so the client can gate the app:
 * this app requires a linked Salesforce account and blocks the chat UI without
 * one. `linkedProviders` is returned to make a missing/renamed connection
 * diagnosable from the blocked screen.
 */
export async function GET() {
  const { userId } = await auth()
  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const { sfUsername, linkedProviders } = await getSalesforceIdentity()
    return NextResponse.json({ sfUsername, linkedProviders })
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unexpected server error"
    console.error("[/api/identity]", message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
