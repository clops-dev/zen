import { mock } from "bun:test";

// Mock auth
mock.module("./src/middleware/api-key", () => ({
  verifyApiKey: async () => ({ id: "123e4567-e89b-12d3-a456-426614174000", email: "test@example.com" }),
  // keep requireApiKey as the original one so we don't have to redefine it
  // Wait, mock.module replaces the whole module. We must provide requireApiKey
  requireApiKey: () => async (c: any, next: any) => {
    c.set("apiUser", { id: "123e4567-e89b-12d3-a456-426614174000", email: "test@example.com" });
    return next();
  }
}));

// Mock rateLimit
mock.module("./src/middleware/rate-limit", () => ({
  rateLimit: () => async (c: any, next: any) => next()
}));

// Mock quota
let quotaMock = { allowed: false, reason: "quota_exceeded", maxComplexityTier: "smart" };
mock.module("./src/lib/quota", () => ({
  checkQuota: async () => quotaMock,
  recordUsage: async () => {}
}));

// Mock pickRoute (so it thinks no providers configured, returning null)
mock.module("./src/lib/routing", () => ({
  pickRoute: async () => null,
  reportRouteOutcome: async () => {}
}));

// Mock cache
mock.module("./src/lib/cache", () => ({
  hashPrompt: () => "hash",
  getCached: async () => null,
  setCached: async () => {}
}));

// We must import gateway AFTER mocking
import { gateway } from "./src/routes/gateway";
import { Hono } from "hono";

const app = new Hono();
app.route("/v1", gateway);

async function run() {
  quotaMock = { allowed: false, reason: "quota_exceeded", maxComplexityTier: "smart" };
  const res402 = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer fake" },
    body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] })
  });
  console.log("--- 402 Quota Exceeded ---");
  console.log("Status:", res402.status, "Content-Type:", res402.headers.get("content-type"));
  console.log(JSON.stringify(await res402.json(), null, 2));

  quotaMock = { allowed: false, reason: "suspended", maxComplexityTier: "smart" };
  const res403 = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer fake" },
    body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] })
  });
  console.log("\n--- 403 Suspended ---");
  console.log("Status:", res403.status, "Content-Type:", res403.headers.get("content-type"));
  console.log(JSON.stringify(await res403.json(), null, 2));

  quotaMock = { allowed: true, reason: "", maxComplexityTier: "smart" };
  const resAllFail = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer fake" },
    body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] })
  });
  console.log("\n--- 503 NO_PROVIDERS_CONFIGURED (Non-stream) ---");
  console.log("Status:", resAllFail.status, "Content-Type:", resAllFail.headers.get("content-type"));
  console.log(JSON.stringify(await resAllFail.json(), null, 2));

  const resAllFailStream = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer fake" },
    body: JSON.stringify({ stream: true, messages: [{ role: "user", content: "hi" }] })
  });
  console.log("\n--- 503 NO_PROVIDERS_CONFIGURED (Stream) ---");
  console.log("Status:", resAllFailStream.status, "Content-Type:", resAllFailStream.headers.get("content-type"));
  console.log(await resAllFailStream.text());
}

run().catch(console.error);
