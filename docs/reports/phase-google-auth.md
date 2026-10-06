# Google OAuth & Device Auth Security Hardening Report

## Summary
Hardened the Google OAuth 2.0 flow against account takeover, silent linking, impersonation, and CSRF/replay attacks. Redesigned the CLI device-login flow to follow RFC 8628, replacing the phishable device_code-in-URL approach with a short human user_code, explicit consent screen, CSRF protection, poll interval enforcement with slow_down, lockout after failed attempts, and single-use claim. All 28 new security and happy-path tests pass alongside the full 266-test suite and clean typecheck (0 errors).

## Items — Google OAuth

- **Requirement 1 done** — Reject login unless userinfo has `email_verified === true`. Validate ID token (signature, iss, aud, exp, nonce, email_verified) with Google JWKS and verify nonce:
  - Files changed: `src/lib/google-token.ts`, `src/lib/google-token.test.ts`, `src/routes/google-auth.ts`, `src/routes/google-auth.test.ts`
  - Proving commands:
    - `bun test src/lib/google-token.test.ts` (7 pass, 0 fail)
    - `bun test src/routes/google-auth.test.ts` (13 pass, 0 fail)
- **Requirement 2 done** — Never auto-link Google to an existing account with role "admin":
  - Files changed: `src/routes/google-auth.ts`, `src/routes/google-auth.test.ts`
  - Proving command: `bun test src/routes/google-auth.test.ts -t "admin"` (passes: attack test confirms no link, no session, fails closed).
- **Requirement 3 done** — For existing password accounts: do NOT silently link. Require user to be logged in to that account first and explicitly link:
  - Files changed: `src/routes/google-auth.ts`, `src/routes/google-auth.test.ts`
  - Proving command: `bun test src/routes/google-auth.test.ts -t "password account"` (passes: unauthenticated attempt rejected with no silent link; logged-in user explicitly links).
- **Requirement 4 done** — Normalize emails with `lower(trim())` on every read/write, add migration `024_normalize_user_emails.sql` with a UNIQUE index on `lower(email)`, and handle existing duplicates safely (report them without deleting):
  - Files changed: `src/lib/email.ts`, `src/lib/email.test.ts`, `migrations/024_normalize_user_emails.sql`, `src/routes/auth.ts`, `src/routes/web.ts`, `src/routes/admin-api.ts`, `src/routes/google-auth.ts`
  - Proving commands:
    - `bun test src/lib/email.test.ts` (3 pass, 0 fail)
    - `bun test src/routes/google-auth.test.ts -t "email normalization"` (1 pass, 0 fail)
- **Requirement 5 done** — Make callback fail closed on every error path, log server-side with request_id, and never reveal which check failed to browser:
  - Files changed: `src/routes/google-auth.ts`, `src/routes/google-auth.test.ts`, `zencode/src/pages/LoginPage.tsx`
  - Proving command: `bun test src/routes/google-auth.test.ts` (all failure paths return 303 to `/zencode/login?error=auth_failed`, cookies cleared, structured log emitted).
- **Requirement 6 done** — Check suspended/disabled users before issuing a session:
  - Files changed: `src/routes/google-auth.ts`, `src/routes/auth.ts`, `src/routes/web.ts`, `src/routes/google-auth.test.ts`
  - Proving command: `bun test src/routes/google-auth.test.ts -t "suspended"` (passes: suspended user blocked from logging in).

## Items — RFC 8628 Device Auth

- **Requirement 1 done** — `/device/start` returns high-entropy `device_code` (secret) + 8-char `user_code` (no ambiguous chars). Verification URI does NOT contain `device_code`:
  - Files changed: `src/lib/device-code.ts`, `src/lib/device-code.test.ts`, `src/routes/device-auth.ts`, `migrations/025_rfc8628_device_auth.sql`
  - Proving command: `bun test src/lib/device-code.test.ts` (5 pass: code length, charset, formatting, normalization, constant-time compare).
- **Requirement 2 done** — Browser page requires user to enter/confirm `user_code`, shows explicit consent screen (IP, user-agent, time, phishing warning), approval via CSRF-protected POST:
  - Files changed: `src/routes/web.ts`, `src/routes/device-auth.ts`
- **Requirement 3 done** — Poll endpoint: rate limit per device_code and per IP, enforce interval with `slow_down` penalty, expired token detection, constant-time comparison, single-use `claimed` transition:
  - Files changed: `src/routes/device-auth.ts`
- **Requirement 4 done** — API key minted only at the instant of successful poll (not at approval time), preventing key leakage if approval is compromised:
  - Files changed: `src/routes/device-auth.ts`
- **Requirement 5 done** — Device requests expire after 10 minutes; opportunistic background cleanup of stale rows:
  - Files changed: `src/routes/device-auth.ts`
- **Requirement 6 done** — Approval requires logged-in session; unauthenticated users redirected to login with redirect back:
  - Files changed: `src/routes/web.ts`
- **Requirement 7 done** — Failed user_code attempts tracked; request locked after 5 failures:
  - Files changed: `src/routes/device-auth.ts`

## Metrics
- Full test suite: 266 pass, 57 skip (test DB dependent), 0 fail.
- New tests added: 28 (7 google-token, 13 google-auth, 5 device-code, 3 email).
- Typecheck: 0 errors (`tsc --noEmit`).

## Needs human decision
- If existing production database contains accounts with duplicate emails differing only by casing (e.g., `user@example.com` and `User@example.com`), Migration 024 detects and reports them via `RAISE WARNING` without dropping rows or creating the unique index until operators merge/deduplicate those accounts manually.

## Risks and rollout notes
- Migration `024_normalize_user_emails.sql` is additive and idempotent. Run at boot.
- Migration `025_rfc8628_device_auth.sql` adds columns to `device_auth_requests` with defaults. No downtime needed.
- Ensure `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_CALLBACK_URL` environment variables are populated.
- Existing CLI clients using the old `/device/start` flow (with `device_code` in URL) will need to update to the new user_code flow.

## Follow-ups you noticed but did not do
- If email-token confirmation for unauthenticated password account linking is desired in addition to logged-in session linking, an email delivery service (e.g. Resend/Postmark) would need to be integrated.
- IP geolocation service could enhance the consent screen's "Requesting IP" with actual city/country rather than just the IP.

## Checked and found NOT a problem
- `email_verified` check is enforced across both Google's signed ID token payload and the Google userinfo endpoint.
- Admin accounts are protected from both unverified and verified Google identity auto-linking.
- Device code anti-phishing: verification URL no longer contains device_code; user must type the short code manually.
