import { clerkMiddleware } from "@clerk/nextjs/server"

// Next.js 16 renamed the `middleware` file convention to `proxy`. Clerk's
// `clerkMiddleware()` runs here so `auth()` is available in route handlers and
// server components. Route-level protection is enforced in the code that reads
// the resource (see app/api/chat/route.ts), per Clerk's current guidance.
export default clerkMiddleware()

export const config = {
  matcher: [
    // Run on everything except Next.js internals and static assets, plus always on API routes.
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest))(?:.*)|api|trpc)(.*)",
  ],
}
