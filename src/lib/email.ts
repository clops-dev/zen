/**
 * Canonical email normalization for Zen Gateway.
 *
 * All email reads and writes must pass through normalizeEmail to ensure
 * case-insensitivity and whitespace stripping (e.g. " User@Example.COM " -> "user@example.com").
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}
