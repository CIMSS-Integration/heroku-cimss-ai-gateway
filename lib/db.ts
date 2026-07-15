import "server-only"
import { Pool } from "pg"

// Single shared pool per server process. Next.js may reuse this module across
// hot reloads in dev — stash it on globalThis so we don't leak connections.
const globalForDb = globalThis as unknown as { pgPool?: Pool }

function createPool(): Pool {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    throw new Error(
      "Missing environment variable DATABASE_URL. Set it in .env.local (see .env.example)."
    )
  }
  return new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
  })
}

export const pool = globalForDb.pgPool ?? createPool()

if (process.env.NODE_ENV !== "production") {
  globalForDb.pgPool = pool
}
