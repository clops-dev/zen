# Security Policy

## Supported versions

Security fixes are provided for the latest release on `main`. Older releases are unsupported unless a release-specific advisory states otherwise.

## Reporting a vulnerability

Report suspected vulnerabilities privately to `security@example.com` (placeholder; replace with the maintained security mailbox before publishing). Do not open a public issue containing credentials, exploit details, or sensitive data.

Include the affected version or commit, an impact summary, reproduction steps, and a minimal proof of concept where safe. Redact all secrets and personal data.

## Response SLA

- Acknowledgement: within 2 business days.
- Initial triage: within 5 business days.
- Status updates: at least every 7 business days until resolution.
- Coordinated disclosure: normally within 90 days, or sooner when exploitation is active.

These are targets rather than guarantees.

## Safe harbor

Good-faith security research is authorized when it avoids privacy violations, service disruption, data access beyond what is necessary to demonstrate the issue, and destruction or modification of data. Stop testing and report immediately if you encounter real user data or credentials. We will not pursue legal action for activity that follows this policy and applicable law.

## Secret exposure response

The repository has a known historical `.env` exposure. It must be treated as compromised until credentials are rotated and history is rewritten by an authorized repository administrator. See `docs/incidents/historical-env-exposure.md` and `docs/security/credential-rotation-checklist.md`.

Never commit `.env` files, provider credentials, database URLs containing passwords, session secrets, API keys, private keys, tokens, or real passwords. Use `.env.example` with placeholders only.

## Authentication & Anti-Abuse Controls

1. **Email Normalization & Canonicalization**:
   - Stored in lowercase/trimmed format (`email`).
   - Canonicalized for uniqueness checks (`canonical_email`) by stripping dots and `+tag` suffixes for Google/Gmail and Protonmail domains to prevent free-credit farming via alias permutations.
2. **Disposable Email Blocking**:
   - Domain blocklist loaded at build time (`src/lib/disposable-domains.json`) rejecting registration attempts from disposable or temporary mail providers.
3. **Welcome Credit Dedup**:
   - Granted only upon verified email confirmation (`/verify-email`) or Google OAuth verified email.
   - Deduped per canonical identity (`welcome_grants` table) and throttled per IP window (configurable via `WELCOME_GRANTS_PER_IP_PER_24H`, default 2 per 24 hours).
4. **Password Policy & Breach Detection**:
   - Minimum 10 characters required.
   - Checked against HaveIBeenPwned range API using 5-character SHA-1 k-anonymity (never transmits complete password hashes; fails open on network errors).
   - Hashed using native Argon2id (`Bun.password`).
5. **Rate Limiting & Non-Enumerable Responses**:
   - Endpoints (`/signup`, `/login`, `/verify-email`, `/password-reset/*`, `/device/*`) enforce per-IP and per-target rate limiting in Postgres with exponential backoff and lockout.
   - Login and signup endpoints return identical response structures and timing for non-existent users (constant-time dummy password verification) to prevent user enumeration.
6. **Abuse Monitoring & Alerting**:
   - Spikes in failed logins (>10 per email per 15m), rapid signups (>5 per IP per 1h), and disposable email attempts trigger warning alerts and structured `abuse.*` audit events.
