// ABOUTME: Vault earnings demo helpers — APY constant, accrued-yield estimate, and earning labels.
// ABOUTME: Ported from the armada-app design mockup (pages/earnFlowConstants.ts).
import { formatUsdcAmount } from '@/components/dashboard/dashboardFormat'

/** Demo vault APY — matches BalanceCard ellipses menu meta. */
export const DEMO_EARN_APY = 4.2

/** Demo accrued yield for vault bar — ~30 days at the quoted APY. */
export function estimateVaultEarnedSoFar(
  balance: number,
  apy: number = DEMO_EARN_APY,
  daysAccrued = 30,
): number {
  if (balance <= 0 || apy <= 0) return 0
  return balance * (apy / 100) * (daysAccrued / 365)
}

export function formatVaultEarningLabel(apy: number): string {
  return `Earning ${apy.toFixed(1)}% APR`
}

export function formatEarnedSoFarAmount(value: number): string {
  if (value <= 0) return '+0'
  return `+${formatUsdcAmount(value)}`
}
