/**
 * test/harness/app-helpers.ts
 *
 * Boot the Hono app in-process against a test database schema.
 *
 * The gateway's src/lib/db.ts opens the postgres pool at module-load time
 * using env.DATABASE_URL. Since Bun caches modules, we can't swap
 * DATABASE_URL mid-process. Instead we monkey-patch the imported `sql` pool
 * and run the app with the correct test connection.
 *
 * Strategy:
 *   1. Set TEST_DATABASE_URL in env before any imports from src/.
 *   2. Import server.ts (which re-exports the Hono app).
 *   3. Use the real Hono app's .fetch() directly — no HTTP server needed.
 *      This avoids port conflicts and speeds up tests.
 *
 * For tests that need the full HTTP semantics (streaming SSE, etc.), use
 * startTestServer() which binds to a random port.
 */

import app from "../../src/server"

export type AppFetch = (input: Request | string, init?: RequestInit) => Promise<Response>

/**
 * Returns a fetch-like function that calls the Hono app directly.
 * Useful for non-streaming tests.
 */
export function appFetch(baseUrl = "http://localhost"): AppFetch {
  return async (input: Request | string, init?: RequestInit): Promise<Response> => {
    const req = typeof input === "string"
      ? new Request(baseUrl + input, init)
      : input
    return app.fetch(req)
  }
}

/**
 * Start the Hono app on a random port for tests that need real HTTP
 * (streaming SSE via fetch, openai/ai SDK clients, etc).
 */
export interface TestServer {
  /** Base URL e.g. http://127.0.0.1:PORT */
  url: string
  /** The underlying Bun server — use for cleanup */
  stop(): Promise<void>
}

export async function startTestServer(): Promise<TestServer> {
  const server = Bun.serve({
    port: 0,
    fetch: app.fetch,
  })
  const url = `http://127.0.0.1:${server.port}`
  return {
    url,
    async stop() { await server.stop() },
  }
}

/**
 * Build a signed authorization header for a raw API key.
 */
export function bearerHeader(rawKey: string): Record<string, string> {
  return { Authorization: `Bearer ${rawKey}` }
}
