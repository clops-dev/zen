type Sql = (strings: TemplateStringsArray, ...values: unknown[]) => any

export async function bootstrapConfiguredAdmin({
  sql, email, password, hashPassword, verifyPassword, revokeAllSessions, invalidateActiveUserCache,
}: {
  sql: Sql
  email: string
  password: string
  hashPassword: (password: string) => Promise<string>
  verifyPassword: (password: string, hash: string) => Promise<boolean>
  revokeAllSessions: (userId: string) => Promise<void>
  invalidateActiveUserCache: (userId: string) => void
}): Promise<{ id: string; passwordSynced: boolean }> {
  const [configuredAdmin] = await sql`
    SELECT id, password_hash FROM users WHERE lower(email) = lower(${email}) LIMIT 1
  `
  let adminUser: { id: string }
  let passwordSynced = false
  if (configuredAdmin) {
    const passwordMatches = await verifyPassword(password, configuredAdmin.password_hash)
    const passwordHash = passwordMatches ? configuredAdmin.password_hash : await hashPassword(password)
    const [updated] = await sql`
      UPDATE users SET password_hash = ${passwordHash}, role = 'admin', status = 'active'
      WHERE id = ${configuredAdmin.id} RETURNING id
    `
    adminUser = updated
    passwordSynced = !passwordMatches
  } else {
    const passwordHash = await hashPassword(password)
    const [created] = await sql`
      INSERT INTO users (email, password_hash, role, status)
      VALUES (${email}, ${passwordHash}, 'admin', 'active') RETURNING id
    `
    adminUser = created
    passwordSynced = true
  }
  await sql`
    INSERT INTO subscriptions (user_id, tier, status, token_budget_monthly)
    VALUES (${adminUser.id}, 'enterprise', 'active', 999999999)
    ON CONFLICT (user_id) DO NOTHING
  `
  await sql`
    DELETE FROM auth_rate_limits
    WHERE endpoint = 'login' AND key_type = 'email' AND lower(key_value) = lower(${email})
  `
  await revokeAllSessions(adminUser.id)
  invalidateActiveUserCache(adminUser.id)
  return { id: adminUser.id, passwordSynced }
}
