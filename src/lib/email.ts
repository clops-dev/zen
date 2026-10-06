/**
 * Email utilities for Zen Gateway.
 *
 * Two distinct concepts:
 *  - normalizeEmail(email): display/storage canonical form — lower(trim()).
 *    Used everywhere for case-insensitive matching and storage.
 *  - canonicalEmail(email): deduplication key for anti-farming.
 *    For Gmail-like providers, strips dots from the local part and removes
 *    the +tag, so "F.oo+1@gmail.com" and "foo@gmail.com" share the same key.
 *    The canonical key is stored in users.canonical_email and checked against
 *    welcome_grants to prevent multi-account farming.
 *  - isDisposableDomain(email): returns true if the domain is on our
 *    maintained blocklist. Checked at signup to prevent throwaway-email abuse.
 */

import disposableDomains from "./disposable-domains.json"

const DISPOSABLE_SET = new Set(disposableDomains as string[])

/**
 * Domains that behave like Gmail for canonicalization purposes:
 * - dots in local part are ignored
 * - +tags are stripped
 */
const GMAIL_LIKE_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "pm.me",
  "protonmail.com",
  "proton.me",
  "fastmail.com",
  "fastmail.fm",
  "hotmail.com",
  "live.com",
  "outlook.com",
])

/**
 * Display/storage canonical form.
 * All email reads and writes must pass through normalizeEmail to ensure
 * case-insensitivity and whitespace stripping.
 * e.g. " User@Example.COM " → "user@example.com"
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

/**
 * Deduplication canonical form.
 * Produces a single key for addresses that go to the same mailbox:
 * - All addresses: lower + trim (same as normalizeEmail)
 * - Gmail-like domains: strip dots and +tags from local part
 *
 * ONLY used for uniqueness/dedup checks, never for sending or display.
 * The original normalized email is preserved for actual mail delivery.
 *
 * Examples:
 *   "F.oo+1@gmail.com" → "foo@gmail.com"
 *   "user+tag@protonmail.com" → "user@protonmail.com"
 *   "user+tag@custom.com" → "user+tag@custom.com" (unchanged)
 */
export function canonicalEmail(email: string): string {
  const normalized = normalizeEmail(email)
  const atIdx = normalized.lastIndexOf("@")
  if (atIdx === -1) return normalized

  const local = normalized.slice(0, atIdx)
  const domain = normalized.slice(atIdx + 1)

  if (GMAIL_LIKE_DOMAINS.has(domain)) {
    // Strip +tag
    const localNoTag = local.split("+")[0]
    // Strip dots
    const localNoDots = localNoTag.replace(/\./g, "")
    return `${localNoDots}@${domain}`
  }

  return normalized
}

/**
 * Returns true if the email's domain is on the disposable-email blocklist.
 * Fast O(1) Set lookup.
 */
export function isDisposableDomain(email: string): boolean {
  const normalized = normalizeEmail(email)
  const atIdx = normalized.lastIndexOf("@")
  if (atIdx === -1) return false
  const domain = normalized.slice(atIdx + 1)
  return DISPOSABLE_SET.has(domain)
}
