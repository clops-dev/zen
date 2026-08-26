# Zen Gateway — Security Notice

## ⚠️ Credential Exposure in Git History

During Phase 2 audit, the following files were found committed in the git history
(both in `Initial commit` and subsequent commits):

| File | Severity | Contents |
|------|----------|----------|
| `.env` | **CRITICAL** | Live Neon PostgreSQL credentials, API keys, session secret |

**Specifically, the following credential types were committed:**

- `DATABASE_URL` — Neon PostgreSQL connection string with password (CRITICAL)
- `SESSION_SECRET` — 64-char hex secret used for cookie signing (HIGH)
- `ANTHROPIC_AUTH_TOKEN` — AgentRouter Anthropic-compatible API key (HIGH)
- `AGENTROUTER_API_KEY` — AgentRouter OpenAI-compatible API key (HIGH)
- `ADMIN_PASSWORD` — Bootstrap admin password (MEDIUM)

**DO NOT print or share the actual values — they are already in git history.**

---

## Immediate Remediation Steps

### 1. Rotate all credentials NOW

Before anything else, rotate every credential that was committed:

```bash
# 1. Rotate the Neon database password via the Neon console
#    → https://console.neon.tech → Settings → Connection string → Reset password

# 2. Generate a new SESSION_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# 3. Rotate/revoke the AgentRouter API keys
#    → https://agentrouter.org → API Keys → Revoke old keys, create new ones

# 4. Change the admin password after login via the dashboard
```

### 2. Remove the .env from git history

After rotating, purge `.env` from the entire git history:

```bash
# Using git-filter-repo (recommended):
pip install git-filter-repo
git filter-repo --invert-paths --path .env

# OR using BFG Repo Cleaner:
java -jar bfg.jar --delete-files .env
git reflog expire --expire=now --all
git gc --prune=now --aggressive
git push origin --force --all
```

> **Note**: All collaborators must re-clone after history rewrite.

### 3. Verify .gitignore is in place

The `.gitignore` now excludes `.env` and all secret files. Verify:

```bash
git check-ignore -v .env       # Should output: .gitignore:7:.env
git status                     # .env should NOT appear as an untracked file
```

### 4. Scan for additional secrets

Run secret scanning on the full history:

```bash
# Using Gitleaks:
docker run -v $PWD:/path zricethezav/gitleaks:latest detect --source=/path --no-git
```

---

## Going Forward

- **Never commit `.env`** — use `.env.example` with empty/placeholder values only
- **Use secrets management** in production: environment variables injected at deploy time
- **Rotate credentials regularly** — especially after any suspected exposure
- **Use `.env.production`** (gitignored) for the Compose `env_file:` reference

---

## .env.example Policy

`c\.env.example` must NEVER contain real credentials.  
Use placeholders like `your-value-here` or leave the field blank.

The database URL line in `.env.example` was found to contain what appears to be  
a real Neon connection string. This should be replaced with a placeholder immediately.
