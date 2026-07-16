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

function lastTextContent(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    return content.map((p: any) => (p?.type === "text" ? p.text ?? "" : "")).join(" ")
  }
  return ""
}

export function classifyComplexity(messages: Array<{ role: string; content: unknown }>): ComplexityScore {
  const last = lastTextContent(messages[messages.length - 1]?.content)
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

  const lower = last.toLowerCase()
  const hits = CODE_TASK_KEYWORDS.filter((k) => lower.includes(k))
  if (hits.length) { score += Math.min(hits.length * 2, 8); reasons.push(`keywords:${hits.join(",")}`) }

  if (messages.length > 6) { score += 3; reasons.push("long_conversation") }

  let tier: ComplexityTier
  if (score <= 1) tier = "trivial"
  else if (score <= 6) tier = "simple"
  else if (score <= 12) tier = "medium"
  else tier = "complex"

  return { tier, score, reasons }
}
