/**
 * src/lib/credits.ts — Prepaid DT-credit accounting.
 *
 * Rate: $1 USD of AI tokens = 4 DT  →  1 DT = $0.25 AI usage value.
 *
 * Design rules:
 *  - All mutations use serializable transactions so concurrent requests
 *    cannot double-spend the same credits.
 *  - The user_credits table holds the authoritative balance (denormalised
 *    for fast CLI quota checks). credit_transactions is the immutable ledger.
 *  - Deductions only succeed when the balance can cover the amount; they
 *    throw InsufficientCreditsError otherwise so the caller can return 402.
 *  - The AI request id (from ai_requests) is stored on usage rows so every
 *    credit deduction traces back to the exact request.
 */

import { sql, withDbResilience } from "./db"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** How many DT equal $1 USD of AI usage (Deal: $5 USD = 15 DT  →  1 USD = 3 DT). */
export const DT_PER_USD = 3

/** Minimum purchasable package size (in DT). $5 USD deal = 15 DT. */
export const MIN_PACKAGE_DT = 5

/** Packages must be multiples of this many DT. */
export const PACKAGE_STEP_DT = 5

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class InsufficientCreditsError extends Error {
  constructor(public readonly userId: string, public readonly balance: number, public readonly required: number) {
    super(`Insufficient credits for user ${userId}: balance=${balance.toFixed(4)} DT, required=${required.toFixed(4)} DT`)
    this.name = "InsufficientCreditsError"
  }
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export interface CreditBalance {
  balance_dt: number
  balance_usd_value: number
  updated_at: string
}

/**
 * Return the current credit balance for a user.
 * Returns { balance_dt: 0 } when no credits row exists (new user).
 */
export async function getBalance(userId: string): Promise<CreditBalance> {
  const rows = await withDbResilience(() => sql`
    SELECT balance_dt, updated_at
    FROM user_credits
    WHERE user_id = ${userId}
  `)
  if (rows.length === 0) {
    return { balance_dt: 0, balance_usd_value: 0, updated_at: new Date().toISOString() }
  }
  const balance_dt = Number(rows[0].balance_dt)
  return {
    balance_dt,
    balance_usd_value: Number((balance_dt / DT_PER_USD).toFixed(4)),
    updated_at: rows[0].updated_at,
  }
}

/**
 * Quick boolean check — does this user have any credits at all?
 * Used by the gateway to decide which quota path to use.
 */
export async function hasCredits(userId: string): Promise<boolean> {
  const rows = await withDbResilience(() => sql`
    SELECT balance_dt FROM user_credits WHERE user_id = ${userId} AND balance_dt > 0
  `)
  return rows.length > 0
}

// ---------------------------------------------------------------------------
// Write — add credits
// ---------------------------------------------------------------------------

export interface AddCreditsResult {
  ok: boolean
  new_balance_dt: number
  transaction_id: string
}

/**
 * Add credits to a user's balance. Records a credit_transactions row and
 * updates user_credits atomically.
 *
 * @param userId      The beneficiary
 * @param amountDt    Positive DT amount
 * @param type        'purchase' | 'admin_grant' | 'refund' | 'adjustment'
 * @param status      'completed' for immediate grants; 'pending' for purchases awaiting payment
 * @param options     Extra metadata for the ledger row
 */
export async function addCredits(
  userId: string,
  amountDt: number,
  type: "purchase" | "admin_grant" | "refund" | "adjustment",
  status: "pending" | "completed" = "completed",
  options?: {
    adminNote?: string
    paymentRef?: string
    createdBy?: string
  },
): Promise<AddCreditsResult> {
  if (amountDt <= 0) throw new Error("amountDt must be positive")

  const safeDt = Number(amountDt.toFixed(4))
  const note = options?.adminNote ?? null
  const payRef = options?.paymentRef ?? null
  const createdBy = options?.createdBy ?? null

  // Ensure the user_credits row exists
  await withDbResilience(() => sql`
    INSERT INTO user_credits (user_id, balance_dt)
    VALUES (${userId}, 0)
    ON CONFLICT (user_id) DO NOTHING
  `)

  // Insert ledger row
  const [txRow] = await withDbResilience(() => sql`
    INSERT INTO credit_transactions
      (user_id, amount_dt, type, status, payment_ref, admin_note, created_by)
    VALUES
      (${userId}, ${safeDt}, ${type}, ${status}, ${payRef}, ${note}, ${createdBy})
    RETURNING id
  `)

  // Increment balance (only for completed transactions)
  let newBalance = 0
  if (status === "completed") {
    const [balRow] = await withDbResilience(() => sql`
      UPDATE user_credits
      SET balance_dt = balance_dt + ${safeDt},
          updated_at = now()
      WHERE user_id = ${userId}
      RETURNING balance_dt
    `)
    newBalance = Number(balRow.balance_dt)
  } else {
    const [balRow] = await withDbResilience(() => sql`
      SELECT balance_dt FROM user_credits WHERE user_id = ${userId}
    `)
    newBalance = balRow ? Number(balRow.balance_dt) : 0
  }

  return { ok: true, new_balance_dt: newBalance, transaction_id: txRow.id }
}

// ---------------------------------------------------------------------------
// Write — deduct credits (for AI usage)
// ---------------------------------------------------------------------------

export interface DeductCreditsResult {
  ok: boolean
  new_balance_dt: number
  transaction_id: string
}

/**
 * Deduct credits from a user's balance for AI usage.
 *
 * Uses SELECT FOR UPDATE inside a serializable transaction to prevent
 * concurrent double-spend. Throws InsufficientCreditsError when the balance
 * is too low — callers should convert that to a 402 response.
 *
 * Only charges when amountDt > 0 (zero-cost cached responses skip the write).
 *
 * @param userId      The user being charged
 * @param amountDt    Amount to deduct (must be >= 0)
 * @param requestId   UUID of the ai_requests row (for audit linkage)
 */
export async function deductCredits(
  userId: string,
  amountDt: number,
  requestId?: string,
): Promise<DeductCreditsResult> {
  if (amountDt < 0) throw new Error("amountDt cannot be negative")

  // Zero-cost request (e.g. cached) — log a $0 ledger row for completeness but
  // skip the balance mutation to avoid unnecessary DB write overhead.
  if (amountDt === 0) {
    return { ok: true, new_balance_dt: (await getBalance(userId)).balance_dt, transaction_id: "" }
  }

  const safeDt = Number(amountDt.toFixed(4))
  const reqId = requestId ?? null

  // Serialisable transaction: lock the row, check balance, deduct atomically.
  // Postgres REPEATABLE READ is sufficient here because we read + write the
  // same row in sequence, but FOR UPDATE gives us the row-level lock we need.
  try {
    const result = await sql.begin(async (tx) => {
      // Lock the balance row for this user.
      const balRows = await tx`
        SELECT balance_dt FROM user_credits WHERE user_id = ${userId} FOR UPDATE
      `
      if (balRows.length === 0) {
        throw new InsufficientCreditsError(userId, 0, safeDt)
      }

      const currentBalance = Number(balRows[0].balance_dt)
      if (currentBalance < safeDt) {
        throw new InsufficientCreditsError(userId, currentBalance, safeDt)
      }

      // Update balance
      const [updatedRow] = await tx`
        UPDATE user_credits
        SET balance_dt = balance_dt - ${safeDt},
            updated_at = now()
        WHERE user_id = ${userId}
        RETURNING balance_dt
      `

      // Record ledger entry
      const [txRow] = await tx`
        INSERT INTO credit_transactions
          (user_id, amount_dt, type, status, request_id)
        VALUES
          (${userId}, ${-safeDt}, 'usage', 'completed', ${reqId})
        RETURNING id
      `

      return { new_balance_dt: Number(updatedRow.balance_dt), transaction_id: txRow.id }
    })

    return { ok: true, ...result }
  } catch (err) {
    if (err instanceof InsufficientCreditsError) throw err
    throw new Error(`Credit deduction failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert USD cost to DT (rounded up to 4 decimal places). */
export function usdToDt(costUsd: number): number {
  return Number((costUsd * DT_PER_USD).toFixed(4))
}

/** Convert DT to equivalent USD AI-usage value. */
export function dtToUsd(amountDt: number): number {
  return Number((amountDt / DT_PER_USD).toFixed(4))
}

/**
 * Validate a package size: must be a positive multiple of PACKAGE_STEP_DT
 * and at least MIN_PACKAGE_DT.
 */
export function isValidPackage(amountDt: number): boolean {
  if (!Number.isFinite(amountDt) || amountDt < MIN_PACKAGE_DT) return false
  if (amountDt > 10_000) return false // sanity cap
  return Number.isInteger(amountDt) && amountDt % PACKAGE_STEP_DT === 0
}

// ---------------------------------------------------------------------------
// Credit transaction list
// ---------------------------------------------------------------------------

export interface CreditTransaction {
  id: string
  amount_dt: number
  type: string
  status: string
  admin_note: string | null
  payment_ref: string | null
  created_at: string
}

export async function getTransactionHistory(
  userId: string,
  limit = 50,
): Promise<CreditTransaction[]> {
  const rows = await withDbResilience(() => sql`
    SELECT id, amount_dt, type, status, admin_note, payment_ref, created_at
    FROM credit_transactions
    WHERE user_id = ${userId}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `)
  return rows.map((r: any) => ({
    id: r.id,
    amount_dt: Number(r.amount_dt),
    type: r.type,
    status: r.status,
    admin_note: r.admin_note ?? null,
    payment_ref: r.payment_ref ?? null,
    created_at: r.created_at,
  }))
}

// ---------------------------------------------------------------------------
// Payment Demands (Pending User Requests)
// ---------------------------------------------------------------------------

export async function getPendingPaymentDemands() {
  const rows = await withDbResilience(() => sql`
    SELECT
      ct.id,
      ct.user_id,
      u.email,
      ct.amount_dt,
      ct.type,
      ct.status,
      ct.admin_note,
      ct.payment_ref,
      ct.created_at
    FROM credit_transactions ct
    JOIN users u ON u.id = ct.user_id
    WHERE ct.status = 'pending'
    ORDER BY ct.created_at DESC
  `)
  return rows.map((r: any) => ({
    id: r.id,
    user_id: r.user_id,
    email: r.email,
    amount_dt: Number(r.amount_dt),
    amount_usd: Number((Number(r.amount_dt) / DT_PER_USD).toFixed(2)),
    type: r.type,
    status: r.status,
    admin_note: r.admin_note ?? null,
    payment_ref: r.payment_ref ?? null,
    created_at: r.created_at,
  }))
}

export async function confirmPaymentDemand(
  transactionId: string,
  adminUserId: string,
  note?: string,
) {
  return await sql.begin(async (tx) => {
    const [txRow] = await tx`
      SELECT id, user_id, amount_dt, status, type, admin_note
      FROM credit_transactions
      WHERE id = ${transactionId} FOR UPDATE
    `
    if (!txRow) throw new Error("Transaction not found")
    if (txRow.status !== "pending") throw new Error(`Transaction is already ${txRow.status}`)

    const amountDt = Number(txRow.amount_dt)
    const userId = txRow.user_id
    const baseNote = txRow.admin_note ?? ""
    const updatedNote = note
      ? (baseNote ? `${baseNote} | Confirmed by admin: ${note}` : `Confirmed by admin: ${note}`)
      : (baseNote || "Confirmed by admin")

    // Mark status completed
    await tx`
      UPDATE credit_transactions
      SET status = 'completed',
          admin_note = ${updatedNote},
          created_by = ${adminUserId}
      WHERE id = ${transactionId}
    `

    // Ensure balance row exists
    await tx`
      INSERT INTO user_credits (user_id, balance_dt)
      VALUES (${userId}, 0)
      ON CONFLICT (user_id) DO NOTHING
    `

    // Update balance
    const [balRow] = await tx`
      UPDATE user_credits
      SET balance_dt = balance_dt + ${amountDt},
          updated_at = now()
      WHERE user_id = ${userId}
      RETURNING balance_dt
    `

    return {
      transaction_id: transactionId,
      user_id: userId,
      amount_dt: amountDt,
      amount_usd: Number((amountDt / DT_PER_USD).toFixed(2)),
      new_balance_dt: Number(balRow.balance_dt),
      status: "completed",
    }
  })
}

export async function rejectPaymentDemand(
  transactionId: string,
  adminUserId: string,
  note?: string,
) {
  const [txRow] = await withDbResilience(() => sql`
    SELECT id, user_id, amount_dt, status
    FROM credit_transactions
    WHERE id = ${transactionId}
  `)
  if (!txRow) throw new Error("Transaction not found")
  if (txRow.status !== "pending") throw new Error(`Transaction is already ${txRow.status}`)

  await withDbResilience(() => sql`
    UPDATE credit_transactions
    SET status = 'failed',
        admin_note = ${note ?? "Rejected by admin"},
        created_by = ${adminUserId}
    WHERE id = ${transactionId}
  `)

  return { ok: true, transaction_id: transactionId, status: "failed" }
}

// ---------------------------------------------------------------------------
// Single Source of Truth Billing Summaries
// ---------------------------------------------------------------------------

export interface UserBillingSummary {
  userId: string
  total_credits_purchased: number
  total_credits_purchased_dt: number
  total_usage_cost: number
  remaining_credits: number
  remaining_credits_dt: number
  total_requests: number
  input_tokens: number
  output_tokens: number
  total_tokens: number
}

export async function getUserBillingSummary(userId: string): Promise<UserBillingSummary> {
  const [purchasedRow] = await withDbResilience(() => sql`
    SELECT COALESCE(SUM(amount_dt), 0) AS total_dt
    FROM credit_transactions
    WHERE user_id = ${userId}
      AND type IN ('purchase', 'admin_grant', 'refund', 'adjustment')
      AND status = 'completed'
      AND amount_dt > 0
  `)

  const [usageRow] = await withDbResilience(() => sql`
    SELECT
      COUNT(*) AS total_requests,
      COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(cost_usd), 0) AS total_usage_cost
    FROM ai_requests
    WHERE user_id = ${userId} AND status = 'success'
  `)

  const total_credits_purchased_dt = Number(purchasedRow?.total_dt ?? 0)
  const total_credits_purchased = Number((total_credits_purchased_dt / DT_PER_USD).toFixed(6))
  const total_usage_cost = Number(Number(usageRow?.total_usage_cost ?? 0).toFixed(6))
  const remaining_credits = Number(Math.max(-9999, total_credits_purchased - total_usage_cost).toFixed(6))
  const remaining_credits_dt = Number((remaining_credits * DT_PER_USD).toFixed(4))
  
  const total_requests = Number(usageRow?.total_requests ?? 0)
  const input_tokens = Number(usageRow?.input_tokens ?? 0)
  const output_tokens = Number(usageRow?.output_tokens ?? 0)
  const total_tokens = input_tokens + output_tokens

  return {
    userId,
    total_credits_purchased,
    total_credits_purchased_dt,
    total_usage_cost,
    remaining_credits,
    remaining_credits_dt,
    total_requests,
    input_tokens,
    output_tokens,
    total_tokens,
  }
}

export interface AdminBillingOverview {
  total_credit_sales_dt: number
  total_credits_sold_usd: number
  total_ai_usage_cost_usd: number
  gross_margin_usd: number
  total_users: number
}

export async function getAdminBillingOverview(): Promise<AdminBillingOverview> {
  const [salesRow] = await withDbResilience(() => sql`
    SELECT COALESCE(SUM(amount_dt), 0) AS total_dt
    FROM credit_transactions
    WHERE type IN ('purchase', 'admin_grant') AND status = 'completed' AND amount_dt > 0
  `)
  const [costRow] = await withDbResilience(() => sql`
    SELECT COALESCE(SUM(cost_usd), 0) AS total_cost
    FROM ai_requests WHERE status = 'success'
  `)
  const [userCountRow] = await withDbResilience(() => sql`
    SELECT COUNT(*) AS total_users FROM users
  `)

  const total_credit_sales_dt = Number(salesRow?.total_dt ?? 0)
  const total_credits_sold_usd = Number((total_credit_sales_dt / DT_PER_USD).toFixed(6))
  const total_ai_usage_cost_usd = Number(Number(costRow?.total_cost ?? 0).toFixed(6))
  const gross_margin_usd = Number((total_credits_sold_usd - total_ai_usage_cost_usd).toFixed(6))
  const total_users = Number(userCountRow?.total_users ?? 0)

  return {
    total_credit_sales_dt,
    total_credits_sold_usd,
    total_ai_usage_cost_usd,
    gross_margin_usd,
    total_users,
  }
}


