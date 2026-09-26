import { createHash } from "node:crypto"

export interface AffinityEntry {
  modelRowId: string
  providerId: string
  modelLabel: string
  pinnedAt: number
  expiresAt: number
}

export interface ConversationAffinityStore {
  get(conversationKey: string): AffinityEntry | null | Promise<AffinityEntry | null>
  set(
    conversationKey: string,
    entry: Omit<AffinityEntry, "expiresAt">,
    ttlMs?: number,
  ): void | Promise<void>
  delete(conversationKey: string): void | Promise<void>
  clear(): void | Promise<void>
}

const DEFAULT_TTL_MS = 3600_000 // 1 hour
const DEFAULT_MAX_SIZE = 10_000

export class InMemoryAffinityStore implements ConversationAffinityStore {
  private map = new Map<string, AffinityEntry>()
  private maxSize: number
  private ttlMs: number

  constructor(maxSize = DEFAULT_MAX_SIZE, ttlMs = DEFAULT_TTL_MS) {
    this.maxSize = maxSize
    this.ttlMs = ttlMs
  }

  get(conversationKey: string): AffinityEntry | null {
    const entry = this.map.get(conversationKey)
    if (!entry) return null

    const now = Date.now()
    if (entry.expiresAt <= now) {
      this.map.delete(conversationKey)
      return null
    }

    // Sliding expiration: extend TTL and bump to most recently used
    entry.expiresAt = now + this.ttlMs
    this.map.delete(conversationKey)
    this.map.set(conversationKey, entry)
    return entry
  }

  set(
    conversationKey: string,
    entry: Omit<AffinityEntry, "expiresAt">,
    ttlMs?: number,
  ): void {
    const now = Date.now()
    const expiresAt = now + (ttlMs ?? this.ttlMs)

    if (this.map.has(conversationKey)) {
      this.map.delete(conversationKey)
    } else if (this.map.size >= this.maxSize) {
      // Evict oldest (LRU)
      const oldestKey = this.map.keys().next().value
      if (oldestKey !== undefined) {
        this.map.delete(oldestKey)
      }
    }

    this.map.set(conversationKey, {
      ...entry,
      expiresAt,
    })
  }

  delete(conversationKey: string): void {
    this.map.delete(conversationKey)
  }

  clear(): void {
    this.map.clear()
  }

  get size(): number {
    return this.map.size
  }
}

let activeStore: ConversationAffinityStore = new InMemoryAffinityStore()

export function getAffinityStore(): ConversationAffinityStore {
  return activeStore
}

export function setAffinityStore(store: ConversationAffinityStore): void {
  activeStore = store
}

export function deriveConversationKey(opts: {
  sessionId?: string | null
  apiKeyId: string
  systemPrompt?: string | null
  firstUserMessage?: string | null
}): string {
  if (opts.sessionId && opts.sessionId.trim()) {
    return opts.sessionId.trim()
  }
  const normSystem = (opts.systemPrompt || "").trim().toLowerCase()
  const normUser = (opts.firstUserMessage || "").trim().toLowerCase()
  const payload = `${opts.apiKeyId}:${normSystem}:${normUser}`
  return createHash("sha256").update(payload).digest("hex")
}
