import "server-only"
import { currentUser } from "@clerk/nextjs/server"

// Same Clerk instance + custom OIDC connection as the sibling
// react-glb-accounting app (mimit-prod branch) — Salesforce SSO surfaces as
// a linked external account, not a Clerk-native field. NOTE: the Backend API
// (what currentUser() from @clerk/nextjs/server calls) prefixes the strategy
// with "oauth_" — confirmed via a direct Backend API call — unlike the
// frontend SDK string the sibling app checks against client-side.
const SALESFORCE_PROVIDER = "oauth_custom_salesforce_mimit_prod"

/**
 * Resolves the signed-in user's Salesforce username via their linked Clerk
 * external account, or null if they aren't signed in or haven't linked one.
 * Callers are expected to have already gated on `auth()` for the plain
 * signed-in check — this is only for the SF-username-keyed persistence path,
 * and its absence should degrade (skip persistence) rather than block chat.
 */
export async function getSalesforceUsername(): Promise<string | null> {
  const user = await currentUser()
  const sfAccount = user?.externalAccounts.find(
    (account) => account.provider === SALESFORCE_PROVIDER
  )
  return sfAccount?.username ?? null
}
