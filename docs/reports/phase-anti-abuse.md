# Phase Report — Anti-Abuse, Welcome-Credit Farming Protection & Auth Hardening

## Summary
Hardened user signup, login, password reset, and welcome credit distribution against automated abuse and farming. Free credits now require verified email or verified Google identity and are strictly deduped per canonical identity and throttled per IP window. Password strength enforces a 10-character minimum with HIBP breach detection, and auth endpoints enforce exponential backoff lockout and timing resistance against user enumeration.

## Items
- **P5.7 (Abuse resistance: signup email verification, disposable blocking, welcome dedup)**: `done`
  - *Files changed*: `src/lib/email.ts`, `src/lib/disposable-domains.json`, `src/lib/email-verification.ts`, `src/lib/auth-rate-limit.ts`, `src/routes/auth.ts`, `src/routes/google-auth.ts`, `migrations/027_anti_abuse.sql`
  - *Proving command*: `bun test src/lib/email.test.ts src/lib/email-verification.test.ts src/lib/auth-rate-limit.test.ts src/routes/auth-anti-abuse.test.ts`
  - *Output summary*: All tests passed (43 passed, 0 failed). Proved 50-variant Gmail aliases canonicalize to the same identity and are prevented from multi-claiming welcome credits; disposable domains rejected with 400.
- **P5.10 (Login throttling, lockout, non-enumerable responses)**: `done`
  - *Files changed*: `src/routes/auth.ts`, `src/lib/auth-rate-limit.ts`
  - *Proving command*: `bun test src/routes/auth-anti-abuse.test.ts`
  - *Output summary*: Verified identical 401 response and timing for existing vs non-existent accounts using `verifyDummyPassword`; verified 429 lockout after failure threshold.
- **P5.11 (Atomic user creation and canonical index)**: `done`
  - *Files changed*: `migrations/027_anti_abuse.sql`, `src/routes/auth.ts`
  - *Proving command*: `bun test src/routes/auth-anti-abuse.test.ts`
  - *Output summary*: Verified unique constraint on `canonical_email` and atomic insert with `ON CONFLICT DO NOTHING`.
- **Password Strength & HIBP Breach Protection**: `done`
  - *Files changed*: `src/lib/password.ts`, `src/lib/password.test.ts`
  - *Proving command*: `bun test src/lib/password.test.ts`
  - *Output summary*: 8 pass, 0 fail. Enforces min 10 chars, queries HIBP range API with SHA-1 k-anonymity (5 chars only), fails open on network errors without exposing breach data.
- **Password Reset Security**: `done`
  - *Files changed*: `src/lib/email-verification.ts`, `src/routes/auth.ts`
  - *Proving command*: `bun test src/routes/auth-anti-abuse.test.ts`
  - *Output summary*: Verified 1-hour TTL, hashed token storage in DB, single-use invalidation on claim, and automatic revocation of all active sessions upon password reset.
- **Abuse Monitoring & Alerting**: `done`
  - *Files changed*: `src/lib/audit.ts`, `src/routes/auth.ts`
  - *Proving command*: `bun test src/routes/auth-anti-abuse.test.ts`
  - *Output summary*: Alerts and structured audit events emitted on >5 signups from same IP in 1h, >10 failed logins per email in 15m, and disposable email attempt spikes.

## Metrics
- **Welcome Credit Farming Surface**: Reduced from unlimited (instant welcome grant per alias) to exactly 1 grant per canonical identity (`developer+1@gmail.com` ... `developer+50@gmail.com` share 1 credit allotment).
- **Authentication Enumeration**: 0 accounts enumerable via error messages or timing differences.
- **Test Suite**: 336 passing tests across 42 files (`bun run test`), 0 failures, 0 TypeScript errors (`tsc --noEmit`).

## Needs Human Decision
- **Email Delivery Service**: Verification links and password reset links currently log to the server console via `console.info`. Production email provider integration (e.g., Postmark, Resend, AWS SES) needs to be configured with credentials and templates.
- **Cloudflare Turnstile CAPTCHA**: Frontend integration for CAPTCHA on signup forms is recommended if sophisticated distributed botnets bypass IP rate limits.

## Risks and Rollout Notes
- **Migration `027_anti_abuse.sql`**: Fully idempotent and additive (`CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`). Backfills `canonical_email` safely from existing `email`.
- **Environment Variables**:
  - `WELCOME_GRANTS_PER_IP_PER_24H` (default: 2)
  - `HIBP_ENABLED` (default: true)
  - `AUTH_RL_*` thresholds for custom fine-tuning.

## Follow-ups You Noticed But Did Not Do
- Dedicated background worker or cron to periodically purge expired tokens from `email_verifications`, `password_reset_tokens`, and aged rows from `auth_rate_limits`.
- Turnstile verification widget in frontend signup SPA.

## Checked and Found NOT a Problem
- **HIBP API Reliability**: Network errors or timeouts against the external HaveIBeenPwned API fail open seamlessly, ensuring users are never blocked from legitimate signups if the external service is degraded.
