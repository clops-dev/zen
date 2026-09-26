import { countTokens as countCl100k, ALL_SPECIAL_TOKENS as ALL_CL100K } from "gpt-tokenizer/encoding/cl100k_base"
import { countTokens as countO200k, ALL_SPECIAL_TOKENS as ALL_O200K } from "gpt-tokenizer/encoding/o200k_base"

const PER_MESSAGE_OVERHEAD = 4 // per OpenAI's published chat-format token rules: role\n + \n
const PER_REQUEST_OVERHEAD = 2 // leading assistant priming

const COUNT_OPTIONS_CL100K = { allowedSpecial: "all" as typeof ALL_CL100K }
const COUNT_OPTIONS_O200K = { allowedSpecial: "all" as typeof ALL_O200K }

export type TokenizerType = "o200k" | "cl100k" | "anthropic" | "gemini" | "approx"

export interface TokenCountInput {
  /** Pre-normalized system prompt (concatenated from system messages), or the
   * raw array of content blocks if you want the counter to flatten it. */
  system?: string | ReadonlyArray<unknown>
  /** Non-system messages, as received from the client (role + content).
   * Tool messages and tool-call deltas are flattened to their textual form
   * here — we only need an upper bound, not a byte-exact reconstruction. */
  messages: ReadonlyArray<{ role: string; content: unknown }>
  /** OpenAI-style tool definitions. Serialized to JSON and added to the
   * count — the provider will re-serialize these too, so the JSON form
   * matches what the model actually sees modulo whitespace. */
  tools?: ReadonlyArray<unknown>
  /** P3.12: Model tokenizer type for accurate counting. Defaults to cl100k. */
  tokenizer?: TokenizerType | string | null
}

/** Conservative token-count estimate of what an OpenAI-style chat completion
 * request will cost on the input side.
 * - Uses o200k_base for newer OpenAI models (gpt-4o, etc.)
 * - Uses cl100k_base for gpt-3.5/gpt-4 models
 * - For Anthropic and Gemini, applies a conservative 1.15x multiplier
 * - For approx, applies a conservative 1.25x multiplier
 * Returns an upper-bound estimate, not an exact count. */
export function countInputTokens(input: TokenCountInput): number {
  const normTokenizer = (input.tokenizer?.toLowerCase() ?? "cl100k") as TokenizerType
  const isO200k = normTokenizer === "o200k" || normTokenizer.includes("o200k")
  const counter = isO200k ? countO200k : countCl100k
  const options = isO200k ? COUNT_OPTIONS_O200K : COUNT_OPTIONS_CL100K

  let total = PER_REQUEST_OVERHEAD
  for (const m of input.messages) {
    total += PER_MESSAGE_OVERHEAD
    total += counter(serializeMessageContent(m), options as any)
  }
  if (input.system) {
    total += PER_MESSAGE_OVERHEAD
    total += counter(flattenSystem(input.system), options as any)
  }
  if (input.tools && input.tools.length > 0) {
    // Provider serializes tools as a JSON array; match that and add a small
    // wrapper overhead. We don't try to be exact — only an upper bound.
    total += counter(JSON.stringify(input.tools), options as any) + 8
  }

  // P3.12: Apply documented conservative multiplier for non-OpenAI models
  let multiplier = 1.0
  if (normTokenizer === "anthropic" || normTokenizer === "gemini") {
    multiplier = 1.15 // 15% conservative margin for Claude / Gemini tokenization
  } else if (normTokenizer === "approx" || (!isO200k && normTokenizer !== "cl100k")) {
    multiplier = 1.25 // 25% conservative margin for generic/approx models
  }

  return Math.ceil(total * multiplier)
}

function flattenSystem(system: string | ReadonlyArray<unknown>): string {
  if (typeof system === "string") return system
  if (Array.isArray(system)) {
    return system
      .map((p: any) => (typeof p === "object" && p && "text" in p ? String(p.text) : ""))
      .join("")
  }
  return ""
}

function serializeMessageContent(m: { role: string; content: unknown }): string {
  const role = m.role || "user"
  if (typeof m.content === "string") return `${role}: ${m.content}`
  // Array content (e.g. multimodal parts) — flatten text parts; ignore the
  // rest with a placeholder. We're estimating, not reconstructing.
  if (Array.isArray(m.content)) {
    const text = m.content
      .map((p: any) => (typeof p === "object" && p && "text" in p ? String(p.text) : ""))
      .join("")
    return `${role}: ${text}`
  }
  // tool calls / tool results — best-effort string form
  return `${role}: ${JSON.stringify(m.content)}`
}

/** Reserve needed to leave room for the model's response on top of input.
 * Used together with `countInputTokens` to decide if a model can fit a
 * request. Uses the larger of: 20% of the context window, or 2048 tokens. */
export function defaultReserveFor(contextWindow: number): number {
  return Math.max(2048, Math.min(8192, Math.floor(contextWindow * 0.2)))
}