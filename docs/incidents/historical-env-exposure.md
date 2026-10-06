# Historical `.env` exposure

## Status

A committed `.env` exists in repository history. Secret scanning identifies generic API-key findings in that historical file. Values are intentionally not reproduced here.

## Required response

1. Rotate every credential listed in `docs/security/credential-rotation-checklist.md`.
2. Purge `.env` and any equivalent secret-bearing blobs from all refs using an authorized history-rewrite procedure.
3. Force-update every affected remote ref only after explicit approval.
4. Re-run Gitleaks and TruffleHog across all refs.
5. Ask all contributors to re-clone or rebase after the rewrite.

No rotation or history rewrite has been performed by this change.
