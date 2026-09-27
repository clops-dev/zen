# Credential rotation runbook

Use this runbook after a suspected credential disclosure. Do not paste a
credential into tickets, chat, shell history, source control, or application
logs. Perform the steps from a secured operator workstation.

## Scope

Rotate all of the following as one incident:

- Production Postgres password / connection URI.
- Session signing secret.
- Each upstream provider key (including AgentRouter/OpenRouter keys).
- Bootstrap/admin password.
- Any deployment-platform secret that contains one of the above.

## Preparation

1. Declare an incident owner and a short maintenance window. Keep one operator
   responsible for the deployment secret store and one for provider dashboards.
2. Inventory every running gateway replica, worker, preview deployment, and
   local machine that may hold the old configuration. Old replicas must not
   remain reachable after the cutover.
3. Back up operational metadata needed to restore service (provider names,
   endpoint URLs, enabled model IDs, and tier routes). Do not export API keys.
4. Open the database and provider audit logs in separate browser sessions so
   suspicious activity can be recorded before the evidence retention period
   expires.

## Rotate in dependency order

1. **Create replacement provider keys.** Create a new restricted key for each
   upstream. Do not revoke the old key yet. Record only its key identifier,
   owner, creation time, allowed scopes, and intended revocation time.
2. **Update provider keys in the gateway.** Store the replacements in the
   deployment secret manager and update existing provider rows through the
   authenticated admin UI/API. The boot-time environment seeding only fills
   empty provider keys; it deliberately will not overwrite an existing key.
3. **Generate a new session secret locally.** Use a cryptographically secure
   generator, then place the result directly into the deployment secret store.
   Do not print it into logs or commit it. Deploying it invalidates all current
   browser sessions, which is expected.
4. **Change the admin password.** Use the authenticated admin flow while the
   old session is still valid, or follow the approved database-administration
   process. `ADMIN_PASSWORD` is bootstrap-only once an admin user exists, so
   changing that environment variable alone does not change the live password.
5. **Rotate the database password.** Update the production secret store with
   the new connection URI before terminating the old connection. Roll the
   gateway deployment immediately so all replicas reconnect using the new URI.
6. **Verify the new deployment.** Check `/readyz`, authenticate with a newly
   issued API key, make one low-cost provider request, and confirm the request
   log records a successful route. Do not use real customer prompts for this
   check.
7. **Revoke old provider keys.** Once every production replica is verified on
   the new configuration, revoke the old provider keys and invalidate the old
   database password/connection credentials. Verify the old keys fail from a
   controlled test location.

## Verification and monitoring

- Confirm no old deployment revision, preview environment, or worker remains
  active.
- Review database, provider, and deployment audit logs for unknown IPs,
  unusual spend, new API keys, changed provider settings, or unexpected admin
  logins from the exposure date through the rotation time.
- Check gateway error rate, upstream authentication failures, and spend for at
  least 24 hours after rotation.
- Record credential identifiers and rotation timestamps in the incident record;
  never record secret values.

## Repository remediation (separate, explicit approval required)

After all old credentials are revoked, remove the secret file from Git history,
force-push the rewritten history, and require collaborators to re-clone. Then
make CI secret scanning blocking. This is an irreversible repository operation
and must be separately approved and coordinated with all collaborators.

## Rollback

Do not restore exposed credentials. If a new provider key fails, create another
replacement key with the correct scope, deploy it, and revoke the failed new
key. If database connectivity fails after the password change, update the
deployment secret with the corrected *new* URI and redeploy; do not re-enable
the exposed password.
