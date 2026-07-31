import "server-only"
import { auth, clerkClient, currentUser } from "@clerk/nextjs/server"

export type SalesforceIdentity = {
  /** The linked Salesforce username, or null if none is linked. */
  sfUsername: string | null
  /** All linked external-account provider slugs (for diagnostics / the blocked screen). */
  linkedProviders: string[]
}

/** The shape we read off a Clerk user's external accounts (currentUser() and the
 *  Backend API expose the same fields). */
type ExternalAccountLike = {
  provider?: string | null
  username?: string | null
  emailAddress?: string | null
}
type UserLike = { externalAccounts?: ExternalAccountLike[] } | null | undefined

/**
 * True if a Clerk external-account provider slug is this app's Salesforce SSO
 * connection. Clerk names custom OAuth connections `oauth_custom_<slug>`, and the
 * slug is per-connection, NOT per-environment — three instances exist and the
 * names do not track dev-vs-prod:
 *
 *   - `noted-pegasus-87.clerk.accounts.dev` (dev) → `oauth_custom_salesforce_mimit_prod`
 *       Display name "Salesforce MIMIT Prod", but its discovery endpoint points at
 *       a SANDBOX org. The name lies; do not trust it.
 *   - `free-baboon-42.clerk.accounts.dev` (dev, app "CIMSSAIGateway") →
 *       `oauth_custom_mimit_prod_sf`. Genuinely the production org
 *       (`mimit.my.salesforce.com`). This is what the EC2 deployment uses.
 *   - `clerk.themimit.com` (production, `pk_live`) → `oauth_custom_mimit_prod_sf`
 *       Used by the Heroku deployment.
 *
 * So we accept either the word "salesforce" or an "sf" token, which covers all
 * three. A user of this app only ever links the Salesforce connection, so this
 * won't misidentify.
 *
 * If a login redirects to the wrong org, the cause is almost never this function —
 * it is the publishable key selecting a different Clerk instance than the one you
 * configured. Decode it to check: the part after `pk_test_`/`pk_live_` is the
 * base64 frontend-API host.
 */
function isSalesforceProvider(provider: string | null | undefined): boolean {
  const p = (provider ?? "").toLowerCase()
  return p.includes("salesforce") || /(?:^|_)sf(?:_|$)/.test(p)
}

/** Extract the Salesforce identity from a Clerk user's external accounts.
 *  Username falls back to the account's email if the connection didn't populate
 *  a username (both are the user's email on the prod SF connection). */
function fromUser(user: UserLike): SalesforceIdentity {
  const accounts = user?.externalAccounts ?? []
  const linkedProviders = accounts
    .map((a) => a.provider)
    .filter((p): p is string => Boolean(p))
  const sfAccount = accounts.find((a) => isSalesforceProvider(a.provider))
  const sfUsername = sfAccount
    ? sfAccount.username || sfAccount.emailAddress || null
    : null
  return { sfUsername, linkedProviders }
}

/**
 * Resolves the signed-in user's Salesforce identity from their linked Clerk
 * external accounts.
 *
 * Two-stage lookup: the request-scoped `currentUser()` is the fast path, but it
 * was observed returning a user with NO external accounts for some prod
 * sessions — new users hit the "no Salesforce account" screen even though the
 * Backend API clearly has their linked SF account. So when the fast path finds
 * no SF username we re-fetch the user authoritatively via the Backend API
 * (`clerkClient().users.getUser`) before giving up. The Backend fetch only runs
 * on the miss path, so normal logins pay nothing extra.
 */
export async function getSalesforceIdentity(): Promise<SalesforceIdentity> {
  const fast = fromUser((await currentUser()) as UserLike)
  if (fast.sfUsername) return fast

  let authoritative: SalesforceIdentity | null = null
  try {
    const { userId } = await auth()
    if (userId) {
      const client = await clerkClient()
      const full = (await client.users.getUser(userId)) as UserLike
      authoritative = fromUser(full)
      if (authoritative.sfUsername) return authoritative
    }
  } catch (err) {
    console.error(
      "[identity] Backend getUser fallback failed",
      err instanceof Error ? err.message : err
    )
  }

  // Still nothing — surface the richer provider list we saw for diagnostics.
  const best =
    authoritative && authoritative.linkedProviders.length >
      fast.linkedProviders.length
      ? authoritative
      : fast
  console.warn("[identity] no Salesforce username resolved", {
    fastProviders: fast.linkedProviders,
    apiProviders: authoritative?.linkedProviders ?? null,
  })
  return best
}

/** Convenience wrapper: just the Salesforce username (null if not linked). */
export async function getSalesforceUsername(): Promise<string | null> {
  return (await getSalesforceIdentity()).sfUsername
}
