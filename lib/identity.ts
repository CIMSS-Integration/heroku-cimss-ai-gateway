import "server-only"
import { currentUser } from "@clerk/nextjs/server"

export type SalesforceIdentity = {
  /** The linked Salesforce username, or null if none is linked. */
  sfUsername: string | null
  /** All linked external-account provider slugs (for diagnostics / the blocked screen). */
  linkedProviders: string[]
}

/**
 * Resolves the signed-in user's Salesforce identity from their linked Clerk
 * external accounts.
 *
 * Clerk names a custom OAuth connection `oauth_custom_<slug>`, and the slug
 * differs between the dev Clerk instance (`oauth_custom_salesforce_mimit_prod`,
 * confirmed via the Backend API) and the production instance on
 * `clerk.themimit.com`. Matching a hardcoded string therefore fails on prod, so
 * we match any provider whose slug mentions "salesforce" — robust across
 * instances, and a user won't have a non-Salesforce provider we'd confuse.
 */
export async function getSalesforceIdentity(): Promise<SalesforceIdentity> {
  const user = await currentUser()
  const accounts = user?.externalAccounts ?? []
  const linkedProviders = accounts
    .map((a) => a.provider)
    .filter((p): p is string => Boolean(p))
  const sfAccount = accounts.find((a) =>
    a.provider?.toLowerCase().includes("salesforce")
  )
  return { sfUsername: sfAccount?.username ?? null, linkedProviders }
}

/** Convenience wrapper: just the Salesforce username (null if not linked). */
export async function getSalesforceUsername(): Promise<string | null> {
  return (await getSalesforceIdentity()).sfUsername
}
