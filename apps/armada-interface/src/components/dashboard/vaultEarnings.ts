// ABOUTME: Vault earnings helpers — APY constant and earning labels for the vault position bar.
// ABOUTME: Ported from the armada-app design mockup (pages/earnFlowConstants.ts).
import { formatUsdcAmount } from '@/components/dashboard/dashboardFormat'

/** Demo vault APY — matches BalanceCard ellipses menu meta. */
export const DEMO_EARN_APY = 4.2

export function formatVaultEarningLabel(apy: number): string {
  return `Earning ${apy.toFixed(1)}% APR`
}

export function formatEarnedSoFarAmount(value: number): string {
  if (value <= 0) return '+0'
  return `+${formatUsdcAmount(value)}`
}
