import "server-only"
import { currentUser } from "@clerk/nextjs/server"

export type SalesforceIdentity = {
  /** The linked Salesforce username, or null if none is linked. */
  sfUsername: string | null
  /** All linked external-account provider slugs (for diagnostics / the blocked screen). */
  linkedProviders: string[]
}

/**
 * True if a Clerk external-account provider slug is this app's Salesforce SSO
 * connection. Clerk names custom OAuth connections `oauth_custom_<slug>`, and
 * the slug differs per Clerk instance — both confirmed from real logins:
 *   - dev instance:               `oauth_custom_salesforce_mimit_prod`
 *   - prod (clerk.themimit.com):  `oauth_custom_mimit_prod_sf`
 * So we accept either the word "salesforce" or an "sf" token. A user of this
 * app only ever links the Salesforce connection, so this won't misidentify.
 */
function isSalesforceProvider(provider: string | null | undefined): boolean {
  const p = (provider ?? "").toLowerCase()
  return p.includes("salesforce") || /(?:^|_)sf(?:_|$)/.test(p)
}

/**
 * Resolves the signed-in user's Salesforce identity from their linked Clerk
 * external accounts.
 */
export async function getSalesforceIdentity(): Promise<SalesforceIdentity> {
  const user = await currentUser()
  const accounts = user?.externalAccounts ?? []
  const linkedProviders = accounts
    .map((a) => a.provider)
    .filter((p): p is string => Boolean(p))
  const sfAccount = accounts.find((a) => isSalesforceProvider(a.provider))
  return { sfUsername: sfAccount?.username ?? null, linkedProviders }
}

/** Convenience wrapper: just the Salesforce username (null if not linked). */
export async function getSalesforceUsername(): Promise<string | null> {
  return (await getSalesforceIdentity()).sfUsername
}
