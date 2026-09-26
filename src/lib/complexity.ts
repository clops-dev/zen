import type { ComplexityTier } from "./db"

export interface ComplexityScore {
  tier: ComplexityTier
  score: number
  reasons: string[]
}

const GREETING_RE =
  /^\s*(hi|hey|hello|yo|salut|thanks|thank you|ok|okay|bye|cool|nice|good morning|good night)\W*$/i

const CODE_TASK_KEYWORDS = [
  "build", "create", "implement", "refactor", "architecture", "design a",
  "generate", "write a", "debug", "fix this bug", "optimize", "algorithm",
  "website", "app", "api", "database", "schema", "function", "class ",
  "component", "endpoint", "migrate", "deploy", "test suite", "explain in depth",
  "analyze", "compare", "pros and cons", "step by step", "diagram",
  "traceback", "stack trace", "error:", "exception", "diff", "patch",
]

const HAS_CODE_BLOCK = /```/
const MULTI_PART = /\band\b.*\band\b|;|\n\s*[-*]\s|\n\s*\d+\.\s/

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

const KEYWORD_PATTERNS = CODE_TASK_KEYWORDS.map((k) => {
  const trimmed = k.trim()
  const startBound = /^\w/.test(trimmed) ? "\\b" : ""
  const endBound = /\w$/.test(trimmed) ? "\\b" : ""
  return {
    raw: trimmed,
    regex: new RegExp(`${startBound}${escapeRegex(trimmed)}${endBound}`, "i"),
  }
})

function lastTextContent(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content.map((p: any) => (p?.type === "text" ? p.text ?? "" : "")).join(" ")
  }
  return ""
}

export function classifyComplexity(messages: Array<{ role: string; content: unknown }>): ComplexityScore {
  const userMessages = messages.filter((m) => m.role === "user")
  const targetMsg = userMessages.length > 0 ? userMessages[userMessages.length - 1] : messages[messages.length - 1]
  const last = lastTextContent(targetMsg?.content)
  const trimmed = last.trim()
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length
  const reasons: string[] = []
  let score = 0

  if (GREETING_RE.test(trimmed) && messages.length <= 2) {
    return { tier: "trivial", score: 0, reasons: ["greeting_only"] }
  }

  if (wordCount <= 6) reasons.push("very_short")
  else if (wordCount <= 20) { score += 2; reasons.push("short") }
  else if (wordCount <= 80) { score += 5; reasons.push("medium_length") }
  else { score += 8; reasons.push("long") }

  if (HAS_CODE_BLOCK.test(last)) { score += 4; reasons.push("has_code_block") }
  if (MULTI_PART.test(last)) { score += 3; reasons.push("multi_part") }

  const hits = KEYWORD_PATTERNS.filter((p) => p.regex.test(last)).map((p) => p.raw)
  if (hits.length) { score += Math.min(hits.length * 2, 8); reasons.push(`keywords:${hits.join(",")}`) }

  if (messages.length > 6) { score += 3; reasons.push("long_conversation") }

  let tier: ComplexityTier
  if (score <= 1) tier = "trivial"
  else if (score <= 6) tier = "simple"
  else if (score <= 12) tier = "medium"
  else tier = "complex"

  return { tier, score, reasons }
}
