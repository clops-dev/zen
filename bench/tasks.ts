/**
 * bench/tasks.ts
 *
 * P1.6 — Coding task benchmark definitions (30 real tasks).
 * Categorized by:
 *   - algorithmic: logic & computation
 *   - bugfix: finding & fixing an error
 *   - refactor: code cleanup and structural changes
 *   - tool_use: tool-call workflows (file edit, search, command)
 *   - multi_file: cross-module dependencies
 *   - types: TypeScript type puzzles & narrowing
 */

export interface BenchTask {
  id: string
  name: string
  category: "algorithmic" | "bugfix" | "refactor" | "tool_use" | "multi_file" | "types"
  difficulty: "trivial" | "simple" | "medium" | "complex"
  prompt: string
  systemPrompt?: string
  expectedToolCalls?: string[]
  validate: (solution: string) => { passed: boolean; error?: string }
}

export const BENCH_TASKS: BenchTask[] = [
  // -------------------------------------------------------------------------
  // Category: bugfix (8 tasks)
  // -------------------------------------------------------------------------
  {
    id: "bugfix-01-off-by-one",
    name: "Off-by-one in binary search",
    category: "bugfix",
    difficulty: "trivial",
    prompt: "Fix the off-by-one bug in this binary search:\n```js\nfunction binarySearch(arr, target) {\n  let low = 0, high = arr.length;\n  while (low <= high) {\n    const mid = Math.floor((low + high) / 2);\n    if (arr[mid] === target) return mid;\n    if (arr[mid] < target) low = mid + 1;\n    else high = mid;\n  }\n  return -1;\n}\n```",
    validate: (code) => {
      const passed = code.includes("high = arr.length - 1") || code.includes("high = mid - 1")
      return { passed, error: passed ? undefined : "high boundary not adjusted" }
    },
  },
  {
    id: "bugfix-02-promise-all-settled",
    name: "Promise unhandled rejection in loop",
    category: "bugfix",
    difficulty: "simple",
    prompt: "Fix this code so it doesn't fail on first rejected promise: `async function fetchAll(urls) { return Promise.all(urls.map(u => fetch(u))); }`",
    validate: (code) => {
      const passed = code.includes("Promise.allSettled") || code.includes(".catch(")
      return { passed, error: passed ? undefined : "Promise.allSettled or catch not used" }
    },
  },
  {
    id: "bugfix-03-date-iso-timezone",
    name: "Timezone offset in ISO date string",
    category: "bugfix",
    difficulty: "simple",
    prompt: "Write a function `formatLocalDate(d: Date): string` that outputs `YYYY-MM-DD` in local time without UTC date shift.",
    validate: (code) => {
      const passed = code.includes("getFullYear") && code.includes("getMonth") && code.includes("getDate")
      return { passed, error: passed ? undefined : "Missing getFullYear/getMonth/getDate" }
    },
  },
  {
    id: "bugfix-04-prototype-pollution",
    name: "Object merge prototype pollution fix",
    category: "bugfix",
    difficulty: "medium",
    prompt: "Fix prototype pollution vulnerability in recursive merge: prevent `__proto__`, `constructor`, `prototype` keys.",
    validate: (code) => {
      const passed = code.includes("__proto__") && (code.includes("constructor") || code.includes("prototype"))
      return { passed, error: passed ? undefined : "Security checks missing" }
    },
  },
  {
    id: "bugfix-05-regex-redos",
    name: "ReDoS vulnerability fix",
    category: "bugfix",
    difficulty: "medium",
    prompt: "Simplify `/^([a-zA-Z0-9]+)*$/` to avoid catastrophic backtracking while matching alphanumeric strings.",
    validate: (code) => {
      const passed = code.includes("^[a-zA-Z0-9]*$") || code.includes("^[a-zA-Z0-9]+$")
      return { passed, error: passed ? undefined : "Regex not simplified" }
    },
  },
  {
    id: "bugfix-06-event-listener-leak",
    name: "AbortSignal event listener leak",
    category: "bugfix",
    difficulty: "simple",
    prompt: "Ensure the abort event listener is removed when the operation completes successfully to prevent memory leaks.",
    validate: (code) => {
      const passed = code.includes("removeEventListener") || code.includes("{ once: true }")
      return { passed, error: passed ? undefined : "removeEventListener or once: true missing" }
    },
  },
  {
    id: "bugfix-07-json-parse-reviver",
    name: "JSON parse BigInt truncation",
    category: "bugfix",
    difficulty: "medium",
    prompt: "Write a function or reviver to safely parse 64-bit integers in JSON without losing precision.",
    validate: (code) => {
      const passed = code.includes("BigInt")
      return { passed, error: passed ? undefined : "BigInt not used" }
    },
  },
  {
    id: "bugfix-08-race-condition",
    name: "Async lock / mutex for bank balance deduction",
    category: "bugfix",
    difficulty: "medium",
    prompt: "Implement a Mutex class with `acquire(): Promise<() => void>` to prevent race conditions during async state mutation.",
    validate: (code) => {
      const passed = code.includes("Promise") && (code.includes("acquire") || code.includes("lock"))
      return { passed, error: passed ? undefined : "Mutex pattern not implemented" }
    },
  },

  // -------------------------------------------------------------------------
  // Category: algorithmic (7 tasks)
  // -------------------------------------------------------------------------
  {
    id: "algo-01-lru-cache",
    name: "LRU Cache with O(1) get and put",
    category: "algorithmic",
    difficulty: "medium",
    prompt: "Implement an LRUCache with capacity, get(key), and put(key, val) running in O(1) time.",
    validate: (code) => {
      const passed = code.includes("Map") || (code.includes("head") && code.includes("tail"))
      return { passed, error: passed ? undefined : "No Map or doubly linked list found" }
    },
  },
  {
    id: "algo-02-token-bucket",
    name: "Token bucket rate limiter",
    category: "algorithmic",
    difficulty: "medium",
    prompt: "Implement a TokenBucket class with `consume(tokens: number): boolean` and capacity + refillRate.",
    validate: (code) => {
      const passed = code.includes("consume") && (code.includes("refill") || code.includes("tokens"))
      return { passed, error: passed ? undefined : "TokenBucket methods missing" }
    },
  },
  {
    id: "algo-03-topological-sort",
    name: "Topological Sort for DAG",
    category: "algorithmic",
    difficulty: "complex",
    prompt: "Write a topologicalSort function that returns node order or detects cycles in a directed graph.",
    validate: (code) => {
      const passed = code.includes("inDegree") || code.includes("visited") || code.includes("cycle")
      return { passed, error: passed ? undefined : "Topological sort / cycle detection logic missing" }
    },
  },
  {
    id: "algo-04-trie-prefix",
    name: "Prefix Trie implementation",
    category: "algorithmic",
    difficulty: "simple",
    prompt: "Implement Trie with `insert(word: string)` and `startsWith(prefix: string): boolean`.",
    validate: (code) => {
      const passed = code.includes("insert") && code.includes("startsWith")
      return { passed, error: passed ? undefined : "Trie methods missing" }
    },
  },
  {
    id: "algo-05-sliding-window-max",
    name: "Sliding window maximum",
    category: "algorithmic",
    difficulty: "complex",
    prompt: "Find maximum in sliding window of size k in O(n) time using a monotonic deque.",
    validate: (code) => {
      const passed = code.includes("deque") || code.includes("shift") || code.includes("pop")
      return { passed, error: passed ? undefined : "Deque operations missing" }
    },
  },
  {
    id: "algo-06-merge-intervals",
    name: "Merge overlapping intervals",
    category: "algorithmic",
    difficulty: "simple",
    prompt: "Write `mergeIntervals(intervals: number[][]): number[][]` that merges all overlapping intervals.",
    validate: (code) => {
      const passed = code.includes("sort") && (code.includes("push") || code.includes("Math.max"))
      return { passed, error: passed ? undefined : "Sort or max logic missing" }
    },
  },
  {
    id: "algo-07-levenshtein-distance",
    name: "Levenshtein edit distance",
    category: "algorithmic",
    difficulty: "medium",
    prompt: "Write `levenshtein(a: string, b: string): number` using dynamic programming.",
    validate: (code) => {
      const passed = code.includes("Math.min") && (code.includes("dp") || code.includes("matrix") || code.includes("row"))
      return { passed, error: passed ? undefined : "Dynamic programming table / min missing" }
    },
  },

  // -------------------------------------------------------------------------
  // Category: refactor (5 tasks)
  // -------------------------------------------------------------------------
  {
    id: "refactor-01-callback-to-async",
    name: "Convert callback waterfall to async/await",
    category: "refactor",
    difficulty: "simple",
    prompt: "Refactor this fs.readFile waterfall into async/await with try/catch.",
    validate: (code) => {
      const passed = code.includes("async") && code.includes("await") && code.includes("try")
      return { passed, error: passed ? undefined : "Missing async/await or try/catch" }
    },
  },
  {
    id: "refactor-02-flatten-conditionals",
    name: "Early returns to flatten nested if-else",
    category: "refactor",
    difficulty: "trivial",
    prompt: "Refactor nested if-else statements (5 levels deep) into guard clauses with early returns.",
    validate: (code) => {
      const passed = code.includes("return") && !code.includes("else if")
      return { passed, error: passed ? undefined : "Guard clauses not utilized" }
    },
  },
  {
    id: "refactor-03-strategy-pattern",
    name: "Replace switch with strategy map",
    category: "refactor",
    difficulty: "simple",
    prompt: "Replace a 10-branch switch statement on payment methods with a dictionary strategy lookup.",
    validate: (code) => {
      const passed = !code.includes("switch (") && (code.includes("Record<") || code.includes("const strategies") || code.includes("handlers["))
      return { passed, error: passed ? undefined : "Switch not replaced with lookup map" }
    },
  },
  {
    id: "refactor-04-pipe-composition",
    name: "Functional pipeline composition",
    category: "refactor",
    difficulty: "medium",
    prompt: "Implement a `pipe(...fns)` utility in TypeScript supporting type-safe left-to-right composition.",
    validate: (code) => {
      const passed = code.includes("reduce") || code.includes("pipe")
      return { passed, error: passed ? undefined : "Pipe implementation missing" }
    },
  },
  {
    id: "refactor-05-builder-pattern",
    name: "Fluent builder for complex config",
    category: "refactor",
    difficulty: "simple",
    prompt: "Implement a RequestBuilder class with chained `.withUrl()`, `.withHeader()`, `.build()`.",
    validate: (code) => {
      const passed = code.includes("return this") && code.includes("build()")
      return { passed, error: passed ? undefined : "Fluent interface missing 'return this'" }
    },
  },

  // -------------------------------------------------------------------------
  // Category: types (5 tasks)
  // -------------------------------------------------------------------------
  {
    id: "types-01-deep-partial",
    name: "Recursive DeepPartial<T>",
    category: "types",
    difficulty: "simple",
    prompt: "Write a recursive TypeScript type `DeepPartial<T>` that makes all nested properties optional.",
    validate: (code) => {
      const passed = code.includes("DeepPartial") && code.includes("keyof T") && code.includes("?")
      return { passed, error: passed ? undefined : "DeepPartial definition invalid" }
    },
  },
  {
    id: "types-02-flatten-object-keys",
    name: "Dot notation path keys for nested object",
    category: "types",
    difficulty: "complex",
    prompt: "Write a TypeScript type `DotPaths<T>` that yields a union of all dot-separated paths in an object.",
    validate: (code) => {
      const passed = code.includes("${") && code.includes("keyof")
      return { passed, error: passed ? undefined : "Template literal type missing" }
    },
  },
  {
    id: "types-03-discriminated-union-narrowing",
    name: "Type guard for discriminated union",
    category: "types",
    difficulty: "trivial",
    prompt: "Write a user-defined type guard `isSuccess(res: Result): res is SuccessResult`.",
    validate: (code) => {
      const passed = code.includes("is SuccessResult")
      return { passed, error: passed ? undefined : "Type predicate missing" }
    },
  },
  {
    id: "types-04-tuple-to-union",
    name: "Tuple to Union conversion",
    category: "types",
    difficulty: "trivial",
    prompt: "Define a type `TupleToUnion<T extends readonly any[]>` without using built-in utility types.",
    validate: (code) => {
      const passed = code.includes("T[number]")
      return { passed, error: passed ? undefined : "T[number] index access missing" }
    },
  },
  {
    id: "types-05-currying-types",
    name: "Type-safe curry function signature",
    category: "types",
    difficulty: "complex",
    prompt: "Write the TypeScript overload or generic type signature for a 2-argument curried function.",
    validate: (code) => {
      const passed = code.includes("=>") && (code.includes("<A") || code.includes("<T1"))
      return { passed, error: passed ? undefined : "Currying generic signature missing" }
    },
  },

  // -------------------------------------------------------------------------
  // Category: tool_use (5 tasks)
  // -------------------------------------------------------------------------
  {
    id: "tool-01-file-patch",
    name: "Identify file edit command",
    category: "tool_use",
    difficulty: "simple",
    prompt: "Generate a tool call to replace lines in `src/config.ts` replacing `PORT=80` with `PORT=8080`.",
    expectedToolCalls: ["replace_file_content", "patch_file"],
    validate: (code) => {
      const passed = code.includes("replace_file_content") || code.includes("TargetFile") || code.includes("8080")
      return { passed, error: passed ? undefined : "Tool call parameters not detected" }
    },
  },
  {
    id: "tool-02-ripgrep-query",
    name: "Formulate ripgrep pattern",
    category: "tool_use",
    difficulty: "trivial",
    prompt: "Generate grep search parameters to find all occurrences of `export const sql` in the `src/` directory.",
    expectedToolCalls: ["grep_search"],
    validate: (code) => {
      const passed = code.includes("grep_search") || code.includes("export const sql")
      return { passed, error: passed ? undefined : "grep search invocation missing" }
    },
  },
  {
    id: "tool-03-multi-step-investigation",
    name: "Multi-turn investigation flow",
    category: "tool_use",
    difficulty: "medium",
    prompt: "Plan the sequence of tool calls needed to locate a bug, read the stack trace, and apply a patch.",
    validate: (code) => {
      const passed = (code.includes("view_file") || code.includes("grep")) && (code.includes("replace") || code.includes("write"))
      return { passed, error: passed ? undefined : "Tool workflow incomplete" }
    },
  },
  {
    id: "tool-04-json-schema-tool",
    name: "Valid OpenAI function tool definition",
    category: "tool_use",
    difficulty: "simple",
    prompt: "Define an OpenAI-compatible function tool object for `calculator` taking `operation` and `operands` array.",
    validate: (code) => {
      const passed = code.includes('"function"') && code.includes('"parameters"') && code.includes('"properties"')
      return { passed, error: passed ? undefined : "OpenAI function schema missing" }
    },
  },
  {
    id: "tool-05-parallel-tool-args",
    name: "Parallel tool call response formatting",
    category: "tool_use",
    difficulty: "medium",
    prompt: "Format assistant response chunks for two simultaneous tool calls `getWeather` and `getTime`.",
    validate: (code) => {
      const passed = code.includes("tool_calls") && (code.includes("index") || code.includes("getWeather"))
      return { passed, error: passed ? undefined : "Parallel tool calls shape missing" }
    },
  },
]
