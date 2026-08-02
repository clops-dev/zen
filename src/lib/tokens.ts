import { countTokens, ALL_SPECIAL_TOKENS } from "gpt-tokenizer/encoding/cl100k_base"

const PER_MESSAGE_OVERHEAD = 4 // per OpenAI's published chat-format token rules: role\n + \n
const PER_REQUEST_OVERHEAD = 2 // leading assistant priming

// gpt-tokenizer's cl100k_base encoding rejects any string that contains a
// "special" token sequence like ``, `<|fim_prefix|>`, `<|endoftext|>`
// etc. — these are boundary markers used in OpenAI's chat-format wire
// protocol, and the library refuses to encode strings that contain them
// so a careless caller can't smuggle one into a prompt. By default it
// throws `Disallowed special token found: …`.
//
// We use the counter for an upper-bound estimate, NOT to actually
// tokenize a request the model will see. Real LLM calls go through
// @ai-sdk/openai-compatible / @ai-sdk/anthropic, which have their own
// tokenization that handles special tokens correctly. So for our
// counting purposes, allowing all special tokens is safe — the bytes
// get counted like any other plain bytes. This makes the gateway
// robust to user prompts that happen to contain these marker strings
// (e.g. someone pasting a chat template, an LLM trace, or markdown
// fenced code blocks containing `<|...|>`).
const COUNT_OPTIONS = { allowedSpecial: "all" as typeof ALL_SPECIAL_TOKENS }

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
}

/** Conservative token-count estimate of what an OpenAI-style chat completion
 * request will cost on the input side. Uses the cl100k_base encoding
 * (gpt-3.5/4 family); for non-OpenAI providers this is an approximation,
 * but the error is small relative to the context-window check we use it
 * for. Caches nothing — Bun starts fast and a single request is small. */
export function countInputTokens(input: TokenCountInput): number {
  let total = PER_REQUEST_OVERHEAD
  for (const m of input.messages) {
    total += PER_MESSAGE_OVERHEAD
    total += countTokens(serializeMessageContent(m), COUNT_OPTIONS)
  }
  if (input.system) {
    total += PER_MESSAGE_OVERHEAD
    total += countTokens(flattenSystem(input.system), COUNT_OPTIONS)
  }
  if (input.tools && input.tools.length > 0) {
    // Provider serializes tools as a JSON array; match that and add a small
    // wrapper overhead. We don't try to be exact — only an upper bound.
    total += countTokens(JSON.stringify(input.tools), COUNT_OPTIONS) + 8
  }
  return total
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
  return Math.max(2048, Math.floor(contextWindow * 0.2))
}