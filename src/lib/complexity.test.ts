import { describe, test, expect } from "bun:test"
import { classifyComplexity, isAgentRequest } from "./complexity"

describe("P3.2: Agent traffic detection", () => {
  test("detects tools parameter as agent traffic", () => {
    expect(isAgentRequest([{ role: "user", content: "hello" }], [{ type: "function" }])).toBe(true)
  })

  test("detects message with role 'tool' as agent traffic", () => {
    expect(isAgentRequest([
      { role: "user", content: "do something" },
      { role: "assistant", content: "calling tool" },
      { role: "tool", content: "tool output" },
    ])).toBe(true)
  })

  test("detects assistant message with tool_calls as agent traffic", () => {
    expect(isAgentRequest([
      { role: "user", content: "do something" },
      { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function" }] },
    ])).toBe(true)
  })

  test("returns false for regular chat without tools or tool messages", () => {
    expect(isAgentRequest([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ])).toBe(false)
  })
})

describe("P3.3: Complexity classifier word-boundary & last-user scoring", () => {
  test("happy birthday does not match 'app' substring", () => {
    const res = classifyComplexity([{ role: "user", content: "happy birthday" }])
    expect(res.reasons.some(r => r.includes("app"))).toBe(false)
    expect(res.tier).toBe("trivial")
  })

  test("rapid prototype does not match 'api' substring", () => {
    const res = classifyComplexity([{ role: "user", content: "rapid prototype" }])
    expect(res.reasons.some(r => r.includes("api"))).toBe(false)
    expect(res.tier).toBe("trivial")
  })

  test("scores the last USER message, not subsequent tool or assistant messages", () => {
    const res = classifyComplexity([
      { role: "user", content: "hello" },
      { role: "assistant", content: "Let me check" },
      { role: "tool", content: "error: traceback stack trace exception in app api database algorithm" },
    ])
    expect(res.tier).toBe("trivial")
  })

  // 64-prompt labeled fixture set across trivial, simple, medium, complex
  const FIXTURES: Array<{ prompt: string; expectedTier: "trivial" | "simple" | "medium" | "complex" }> = [
    // --- Trivial (16) ---
    { prompt: "hi", expectedTier: "trivial" },
    { prompt: "hello there", expectedTier: "trivial" },
    { prompt: "good morning", expectedTier: "trivial" },
    { prompt: "thanks", expectedTier: "trivial" },
    { prompt: "ok thank you", expectedTier: "trivial" },
    { prompt: "bye", expectedTier: "trivial" },
    { prompt: "happy birthday", expectedTier: "trivial" },
    { prompt: "cool", expectedTier: "trivial" },
    { prompt: "sounds good", expectedTier: "trivial" },
    { prompt: "nice job", expectedTier: "trivial" },
    { prompt: "hey", expectedTier: "trivial" },
    { prompt: "yo", expectedTier: "trivial" },
    { prompt: "what is 2 + 2", expectedTier: "trivial" },
    { prompt: "tell me a joke", expectedTier: "trivial" },
    { prompt: "who wrote hamlet", expectedTier: "trivial" },
    { prompt: "rapid prototype", expectedTier: "trivial" },

    // --- Simple (16) ---
    { prompt: "explain what a closure is in javascript and how scope works", expectedTier: "simple" },
    { prompt: "how do I reverse a string in python efficiently", expectedTier: "simple" },
    { prompt: "what is the capital of France and what is its primary currency", expectedTier: "simple" },
    { prompt: "convert 50 celsius to fahrenheit and explain the formula used", expectedTier: "simple" },
    { prompt: "summarize the plot of Romeo and Juliet in three short sentences", expectedTier: "simple" },
    { prompt: "give me 5 synonyms for happy and joyful moods", expectedTier: "simple" },
    { prompt: "what is difference between let and const in modern javascript syntax", expectedTier: "simple" },
    { prompt: "how do I write a comment in HTML and CSS stylesheets", expectedTier: "simple" },
    { prompt: "what does HTTP 404 status code mean on the web", expectedTier: "simple" },
    { prompt: "show me a regex for email address validation in forms", expectedTier: "simple" },
    { prompt: "what is the speed of light in kilometers per second roughly", expectedTier: "simple" },
    { prompt: "format this JSON string properly for human readability", expectedTier: "simple" },
    { prompt: "how does git rebase work at a high level conceptual view", expectedTier: "simple" },
    { prompt: "translate hello world to Spanish and French languages", expectedTier: "simple" },
    { prompt: "what is docker containerization in one clear introductory paragraph", expectedTier: "simple" },
    { prompt: "why is the sky blue during daytime on earth", expectedTier: "simple" },

    // --- Medium (16) ---
    { prompt: "can you help me debug this error: in my function undefined is not a function", expectedTier: "medium" },
    { prompt: "write a python function to compute fibonacci numbers with memoization and optimize time complexity", expectedTier: "medium" },
    { prompt: "compare relational databases and document stores with pros and cons for ecommerce", expectedTier: "medium" },
    { prompt: "how to implement jwt authentication in express with refresh tokens; step by step", expectedTier: "medium" },
    { prompt: "explain step by step how to optimize this database query for better performance", expectedTier: "medium" },
    { prompt: "write a bash script to backup logs and compress them into an archive daily; explain each flag", expectedTier: "medium" },
    { prompt: "refactor this React component to use useReducer instead of useState hooks and optimize rendering", expectedTier: "medium" },
    { prompt: "how do I configure CORS in nginx and handle preflight OPTIONS requests; show config example", expectedTier: "medium" },
    { prompt: "analyze the time complexity and space complexity of quicksort vs mergesort algorithms in depth", expectedTier: "medium" },
    { prompt: "find the bug in this binary search algorithm implementation and explain why it loops infinitely", expectedTier: "medium" },
    { prompt: "write a test suite for this user authentication controller and mock the database calls", expectedTier: "medium" },
    { prompt: "how do I deploy a Node.js app to AWS ECS with Fargate containers step by step", expectedTier: "medium" },
    { prompt: "what is the difference between TCP and UDP with pros and cons for gaming network architecture", expectedTier: "medium" },
    { prompt: "create a database schema for an online bookstore with authors and orders; include indexes", expectedTier: "medium" },
    { prompt: "write a sql query to find the top 5 customers by sales volume this month and handle ties", expectedTier: "medium" },
    { prompt: "explain the event loop in Node.js step by step with microtask queue and timers", expectedTier: "medium" },

    // --- Complex (16) ---
    {
      prompt: "build a complete microservices architecture for an e-commerce platform with stripe checkout, order processing, and inventory management; include database schema and deploy instructions\n```sql\nCREATE TABLE orders (id uuid);\n```\nstep by step",
      expectedTier: "complex",
    },
    {
      prompt: "implement a custom raft consensus algorithm in Rust with leader election and log replication; explain step by step and provide test suite\n```rust\nstruct RaftNode {}\n```",
      expectedTier: "complex",
    },
    {
      prompt: "refactor this legacy monolithic application into modular services. Here is the code:\n```typescript\nfunction handleAll() { /* large blob */ }\n```\nProvide a full architecture diagram and migration strategy with pros and cons.",
      expectedTier: "complex",
    },
    {
      prompt: "design a distributed cache invalidation system with redis and kafka; analyze race conditions and write a test suite\n```python\ndef invalidate(): pass\n```",
      expectedTier: "complex",
    },
    {
      prompt: "create a compiler frontend with lexer, parser, ast, and type checker for a subset of typescript; step by step guide with error: reporting and traceback diagnostics\n```ts\nclass Lexer {}\n```",
      expectedTier: "complex",
    },
    {
      prompt: "implement an end-to-end OAuth2 OIDC provider in Go with PKCE, rotating refresh tokens, and redis session store;\n```go\nfunc HandleToken() {}\n```\nInclude database schema and test suite",
      expectedTier: "complex",
    },
    {
      prompt: "build a real-time collaborative document editor with Operational Transformation and WebSockets; include backend implementation and architecture diagram;\n```js\nclass OTDoc {}\n```\nstep by step",
      expectedTier: "complex",
    },
    {
      prompt: "optimize this high throughput Kafka consumer pipeline in Java to handle 100k events/sec with zero message loss; analyze bottlenecks and provide stack trace debugging and diff patch\n```java\nvoid consume() {}\n```",
      expectedTier: "complex",
    },
    {
      prompt: "create a zero-knowledge proof verification contract in Solidity with circom circuit integration; explain step by step and implement test suite with diff patch\n```solidity\ncontract Verifier {}\n```",
      expectedTier: "complex",
    },
    {
      prompt: "design a multi-region active-active postgres replication architecture with conflict resolution and disaster recovery; analyze pros and cons and create schema migration\n```sql\nALTER TABLE data ADD COLUMN version int;\n```",
      expectedTier: "complex",
    },
    {
      prompt: "build a custom LLM gateway with complexity routing, circuit breakers, and streaming token count estimation; implement test suite and benchmark harness\n```ts\nfunction route() {}\n```\nstep by step",
      expectedTier: "complex",
    },
    {
      prompt: "implement a B-tree storage engine in C from scratch with disk paging, concurrency locks, and transaction rollback;\n```c\nstruct BTreeNode {}\n```\nInclude algorithm explanation and test suite",
      expectedTier: "complex",
    },
    {
      prompt: "create a Kubernetes custom controller and CRD in Go to manage ephemeral database branches for pull requests;\n```go\nfunc Reconcile() {}\n```\nInclude deployment yaml and architecture diagram",
      expectedTier: "complex",
    },
    {
      prompt: "refactor this deep neural network training loop in PyTorch with mixed precision, distributed DDP, and gradient checkpointing;\n```python\nfor epoch in range(100): pass\n```\nstep by step and analyze memory diff",
      expectedTier: "complex",
    },
    {
      prompt: "build an automated vulnerability scanner with AST analysis and taint tracking for Python and Javascript; explain algorithm in depth and provide test suite\n```py\ndef trace_taint(): pass\n```",
      expectedTier: "complex",
    },
    {
      prompt: "design an enterprise search engine with hybrid sparse BM25 and dense vector embeddings reranking; create database schema and API endpoint with diff patch\n```python\ndef search(): pass\n```",
      expectedTier: "complex",
    },
  ]

  test("evaluates labeled fixture set (64 prompts) and reports before/after accuracy", () => {
    expect(FIXTURES.length).toBeGreaterThanOrEqual(60)

    // Legacy classifier logic (substring match on last message)
    const legacyClassify = (prompt: string): string => {
      const trimmed = prompt.trim()
      const wordCount = trimmed.split(/\s+/).filter(Boolean).length
      if (/^\s*(hi|hey|hello|yo|salut|thanks|thank you|ok|okay|bye|cool|nice|good morning|good night)\W*$/i.test(trimmed)) {
        return "trivial"
      }
      let score = 0
      if (wordCount <= 6) {}
      else if (wordCount <= 20) score += 2
      else if (wordCount <= 80) score += 5
      else score += 8

      if (/```/.test(prompt)) score += 4
      if (/\band\b.*\band\b|;|\n\s*[-*]\s|\n\s*\d+\.\s/.test(prompt)) score += 3

      const lower = prompt.toLowerCase()
      const CODE_TASK_KEYWORDS = [
        "build", "create", "implement", "refactor", "architecture", "design a",
        "generate", "write a", "debug", "fix this bug", "optimize", "algorithm",
        "website", "app", "api", "database", "schema", "function", "class ",
        "component", "endpoint", "migrate", "deploy", "test suite", "explain in depth",
        "analyze", "compare", "pros and cons", "step by step", "diagram",
        "traceback", "stack trace", "error:", "exception", "diff", "patch",
      ]
      const hits = CODE_TASK_KEYWORDS.filter((k) => lower.includes(k))
      if (hits.length) score += Math.min(hits.length * 2, 8)

      if (score <= 1) return "trivial"
      if (score <= 6) return "simple"
      if (score <= 12) return "medium"
      return "complex"
    }

    let legacyCorrect = 0
    let newCorrect = 0

    for (const f of FIXTURES) {
      const legTier = legacyClassify(f.prompt)
      if (legTier === f.expectedTier) legacyCorrect++

      const newRes = classifyComplexity([{ role: "user", content: f.prompt }])
      if (newRes.tier === f.expectedTier) newCorrect++
    }

    const legacyAccuracy = (legacyCorrect / FIXTURES.length) * 100
    const newAccuracy = (newCorrect / FIXTURES.length) * 100

    console.log(`[P3.3 Fixture Results] Total: ${FIXTURES.length} prompts`)
    console.log(`[P3.3 Fixture Results] Legacy substring classifier accuracy: ${legacyAccuracy.toFixed(1)}% (${legacyCorrect}/${FIXTURES.length})`)
    console.log(`[P3.3 Fixture Results] New word-boundary classifier accuracy: ${newAccuracy.toFixed(1)}% (${newCorrect}/${FIXTURES.length})`)

    expect(newAccuracy).toBeGreaterThan(legacyAccuracy)
    expect(newAccuracy).toBeGreaterThanOrEqual(90)
  })
})

