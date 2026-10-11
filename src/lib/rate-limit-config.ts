export const DEFAULT_GATEWAY_RATE_LIMIT_RPM = 50
export const GATEWAY_RATE_LIMIT_WINDOW_MS = 60_000

export function gatewayRateLimitRpm(): number {
  const configured = Number.parseInt(process.env.GATEWAY_RATE_LIMIT_RPM ?? "", 10)
  return Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_GATEWAY_RATE_LIMIT_RPM
}
