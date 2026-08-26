import { createHash } from "node:crypto"
import { sql, withDbResilience } from "./db"

export function hashPrompt(messages: Array<{ role: string; content: unknown }>, salt: string): string {
  const normalized = JSON.stringify(messages.map((m) => ({ role: m.role, content: m.content }))) + "::" + salt
  return createHash("sha256").update(normalized).digest("hex")
}

export interface CacheHit {
  content: string
  inputTokens: number
  outputTokens: number
}

export async function getCached(promptHash: string): Promise<CacheHit | null> {
  const rows = await withDbResilience(() => sql`
    SELECT response_text, usage_json FROM response_cache
    WHERE prompt_hash = ${promptHash} AND expires_at > now()
  `)
  if (rows.length === 0) return null
  await withDbResilience(() => sql`UPDATE response_cache SET hit_count = hit_count + 1 WHERE prompt_hash = ${promptHash}`)
  const usage = rows[0].usage_json
  return { content: rows[0].response_text, inputTokens: usage.input_tokens ?? 0, outputTokens: usage.output_tokens ?? 0 }
}

export async function setCached(
  promptHash: string,
  modelLabel: string,
  content: string,
  inputTokens: number,
  outputTokens: number,
  ttlSeconds = 3600,
): Promise<void> {
  await withDbResilience(() => sql`
    INSERT INTO response_cache (prompt_hash, model_label, response_text, usage_json, expires_at)
    VALUES (
      ${promptHash}, ${modelLabel}, ${content},
      ${JSON.stringify({ input_tokens: inputTokens, output_tokens: outputTokens })}::jsonb,
      now() + (${ttlSeconds} || ' seconds')::interval
    )
    ON CONFLICT (prompt_hash) DO NOTHING
  `)
}
