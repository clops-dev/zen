/**
 * scripts/set-unorouter-flash-lite.ts
 *
 * One-shot: applies the correct metadata to unorouter/gemini-3.1-flash-lite:free
 * so the gateway's capability + context-window checks let it through.
 *
 *   context_window:  1,048,576  (Gemini 3.1 Flash-Lite 1M context)
 *   supports_tools:  true       (function calling)
 *   supports_vision: true       (image input)
 *   supports_json_mode: true    (response_schema)
 *
 * Re-running is safe: it's a plain UPDATE.
 */
import { sql } from "../src/lib/db"

const MODEL_ID = "gemini-3.1-flash-lite:free"
const CONTEXT_WINDOW = 1_048_576

const rows = await sql`
  UPDATE models
  SET context_window = ${CONTEXT_WINDOW},
      supports_tools = true,
      supports_vision = true,
      supports_json_mode = true
  WHERE model_id = ${MODEL_ID}
    AND provider_id = (SELECT id FROM providers WHERE name = 'unorouter')
  RETURNING id, model_id, context_window, supports_tools, supports_vision, supports_json_mode
`

if (rows.length === 0) {
  console.error(`No unorouter model found with model_id = '${MODEL_ID}'.`)
  console.error("Did you run scripts/seed-unorouter.ts first?")
  process.exit(1)
}

console.log("Updated:")
for (const r of rows) {
  console.log(`  ${r.model_id}`)
  console.log(`    context_window:    ${r.context_window}`)
  console.log(`    supports_tools:    ${r.supports_tools}`)
  console.log(`    supports_vision:   ${r.supports_vision}`)
  console.log(`    supports_json_mode:${r.supports_json_mode}`)
}
