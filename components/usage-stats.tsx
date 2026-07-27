"use client"

import { useEffect, useState } from "react"
import { Loader2, RefreshCw } from "lucide-react"
import { cn } from "@/lib/utils"
import type { UserUsageStats } from "@/lib/types"

/** Renders a `lastActive` ISO timestamp as a short relative age ("3d ago"). */
function relativeAge(iso: string | null): string {
  if (!iso) return "—"
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return "—"
  const minutes = Math.round((Date.now() - then) / 60_000)
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(iso).toLocaleDateString()
}

/** The Salesforce username is an email — show the local part, full value on hover. */
function shortName(sfUsername: string): string {
  const at = sfUsername.indexOf("@")
  return at > 0 ? sfUsername.slice(0, at) : sfUsername
}

async function fetchStats(): Promise<UserUsageStats[]> {
  const res = await fetch("/api/chat/stats", { cache: "no-store" })
  const data = await res.json().catch(() => null)
  if (!res.ok) {
    throw new Error(data?.error ?? `Request failed (${res.status})`)
  }
  return (data?.stats as UserUsageStats[]) ?? []
}

function messageFor(err: unknown): string {
  return err instanceof Error ? err.message : "Couldn't load stats."
}

/**
 * Org-wide usage table — chats and messages per user — mounted as the "Stats"
 * custom page of Clerk's `<UserButton />` account modal. Visible to every
 * signed-in user by design.
 *
 * Clerk renders custom pages in a fairly narrow panel, so the layout is a
 * compact 4-column table that scrolls rather than a wide dashboard. `viewer` is
 * the signed-in user's Salesforce username, used only to highlight their row.
 */
export function UsageStats({ viewer }: { viewer: string | null }) {
  const [stats, setStats] = useState<UserUsageStats[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  // Initial load. State starts out "loading", so this path never sets state
  // synchronously during the effect — it only lands in the promise callbacks,
  // and an unmount (closing the modal mid-flight) cancels them.
  useEffect(() => {
    let active = true
    fetchStats()
      .then((rows) => {
        if (active) setStats(rows)
      })
      .catch((err) => {
        if (active) setError(messageFor(err))
      })
      .finally(() => {
        if (active) setIsLoading(false)
      })
    return () => {
      active = false
    }
  }, [])

  /** Re-fetch on demand (refresh button, retry link). */
  async function reload() {
    setIsLoading(true)
    setError(null)
    try {
      setStats(await fetchStats())
    } catch (err) {
      setError(messageFor(err))
    } finally {
      setIsLoading(false)
    }
  }

  const totalChats = stats?.reduce((sum, row) => sum + row.chats, 0) ?? 0
  const totalMessages = stats?.reduce((sum, row) => sum + row.messages, 0) ?? 0

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-base font-medium">Stats</h1>
          <p className="text-muted-foreground text-xs">
            Chats and messages across everyone using this app. Lifetime totals,
            including deleted chats.
          </p>
        </div>
        <button
          type="button"
          onClick={reload}
          disabled={isLoading}
          aria-label="Refresh stats"
          className="text-muted-foreground hover:text-foreground disabled:opacity-50 shrink-0 rounded-md p-1.5"
        >
          <RefreshCw className={cn("h-4 w-4", isLoading && "animate-spin")} />
        </button>
      </div>

      {isLoading && !stats ? (
        <div className="text-muted-foreground flex items-center gap-2 py-8 text-sm">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading stats…
        </div>
      ) : error ? (
        <div className="text-destructive space-y-2 py-4 text-sm">
          <p>{error}</p>
          <button
            type="button"
            onClick={reload}
            className="text-foreground underline underline-offset-2"
          >
            Try again
          </button>
        </div>
      ) : !stats || stats.length === 0 ? (
        <p className="text-muted-foreground py-8 text-sm">
          No chats yet — nothing to report.
        </p>
      ) : (
        <div className="max-h-80 overflow-auto rounded-md border">
          {/* Three things keep the pinned header and totals row from colliding
              with the scrolled rows:
                - `sticky` sits on the cells, not on thead/tfoot — positioning
                  table sections is unreliable across browsers;
                - their backgrounds are fully opaque (bg-muted, not bg-muted/50),
                  or rows sliding underneath show through;
                - the table uses the separate border model, because a collapsed
                  border on a sticky cell isn't painted in Chrome. That means
                  borders live on the cells (the separate model ignores them on
                  rows). */}
          <table className="w-full border-separate border-spacing-0 text-sm">
            <thead className="text-muted-foreground">
              <tr className="[&>th]:bg-muted [&>th]:border-border [&>th]:sticky [&>th]:top-0 [&>th]:z-10 [&>th]:border-b [&>th]:px-3 [&>th]:py-2 [&>th]:font-medium">
                <th className="text-left">User</th>
                <th className="text-right">Chats</th>
                <th className="text-right">Messages</th>
                <th className="text-right">Last active</th>
              </tr>
            </thead>
            <tbody>
              {stats.map((row, index) => (
                <tr
                  key={row.sfUsername}
                  className={cn(
                    "[&>td]:px-3 [&>td]:py-2",
                    index > 0 && "[&>td]:border-border [&>td]:border-t",
                    row.sfUsername === viewer && "bg-primary/5 font-medium"
                  )}
                >
                  <td
                    className="max-w-[10rem] truncate text-left"
                    title={row.sfUsername}
                  >
                    {shortName(row.sfUsername)}
                    {row.sfUsername === viewer && (
                      <span className="text-muted-foreground ml-1 text-xs font-normal">
                        (you)
                      </span>
                    )}
                  </td>
                  <td className="text-right tabular-nums">{row.chats}</td>
                  <td className="text-right tabular-nums">{row.messages}</td>
                  <td className="text-muted-foreground text-right text-xs whitespace-nowrap">
                    {relativeAge(row.lastActive)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="font-medium [&>td]:bg-muted [&>td]:border-border [&>td]:sticky [&>td]:bottom-0 [&>td]:z-10 [&>td]:border-t [&>td]:px-3 [&>td]:py-2">
                <td className="text-left">
                  {stats.length} {stats.length === 1 ? "user" : "users"}
                </td>
                <td className="text-right tabular-nums">{totalChats}</td>
                <td className="text-right tabular-nums">{totalMessages}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  )
}
