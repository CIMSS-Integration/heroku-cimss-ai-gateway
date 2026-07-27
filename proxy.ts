import { clerkMiddleware } from "@clerk/nextjs/server"
import { NextResponse } from "next/server"
import type { NextFetchEvent, NextRequest } from "next/server"

// Next.js 16 renamed the `middleware` file convention to `proxy`. Clerk's
// `clerkMiddleware()` runs here so `auth()` is available in route handlers and
// server components. Route-level protection is enforced in the code that reads
// the resource (see app/api/chat/route.ts), per Clerk's current guidance.
const withClerk = clerkMiddleware()

/** Hosts that are always served over plain http — never redirect these. */
function isLocalHost(host: string): boolean {
  const hostname = host.split(":")[0].toLowerCase()
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1" ||
    hostname.endsWith(".localhost")
  )
}

/**
 * Send plain-http visitors to https (people reach ai.cimss.com / ai.themimit.com
 * over http by mistake).
 *
 * Heroku terminates TLS at its router, so an http request still arrives here as
 * an ordinary request — the original scheme survives only in `x-forwarded-proto`
 * (comma-joined if it passed through more than one proxy; the first hop is the
 * client's).
 *
 * Two guards keep local work off this path, because `next dev` sets
 * `x-forwarded-proto: http` on its own requests — without them, http://localhost
 * redirects to an https://localhost that nothing is listening on: we only run in
 * production builds, and never for a localhost/loopback Host (so `next start`
 * against the local machine still works).
 *
 * The target host comes from the forwarded/Host header rather than
 * `request.url`, whose host is whatever the platform routed to internally. The
 * redirect is 308: permanent, so browsers skip the insecure hop next time, and
 * method-preserving, so a form/API POST isn't silently downgraded to a GET.
 */
function httpsRedirect(request: NextRequest): NextResponse | null {
  if (process.env.NODE_ENV !== "production") return null

  const proto = request.headers.get("x-forwarded-proto")?.split(",")[0].trim()
  if (proto !== "http") return null

  const host =
    request.headers.get("x-forwarded-host") ?? request.headers.get("host")
  if (!host || isLocalHost(host)) return null

  const { pathname, search } = request.nextUrl
  return NextResponse.redirect(
    new URL(`${pathname}${search}`, `https://${host}`),
    308
  )
}

export default function proxy(request: NextRequest, event: NextFetchEvent) {
  return httpsRedirect(request) ?? withClerk(request, event)
}

export const config = {
  matcher: [
    // Run on everything except Next.js internals and static assets, plus always on API routes.
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest))(?:.*)|api|trpc)(.*)",
  ],
}
