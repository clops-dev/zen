import { z } from "zod"

const schema = z.object({
  DATABASE_URL: z.string().url(),
  PORT: z.coerce.number().int().positive().default(8787),
  SESSION_SECRET: z.string().min(32, "must be at least 32 chars — generate with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""),
  BCRYPT_COST: z.coerce.number().int().min(4).max(15).default(12),

  // Bootstrap admin — created automatically on first run if no admin exists.
  // Change the password via the dashboard after first login.
  ADMIN_EMAIL: z.string().email(),
  ADMIN_PASSWORD: z.string().min(8),

  // Default monthly token budget for new free-tier signups.
  DEFAULT_FREE_TOKEN_BUDGET: z.coerce.number().int().positive().default(50000),
})

export const env = schema.parse(process.env)
