// ABOUTME: Aggregated balance view — unshielded USDC per chain, shielded USDC, shielded yield shares.
// ABOUTME: Stub: reads atoms only. Real implementation polls per-chain ERC20.balanceOf + subscribes to shielded balance events.

import { useAtomValue } from 'jotai'
import { shieldedUsdcAtom, usdcBalancesAtom, yieldSharesAtom } from '@/state/wallet'

export interface UseBalancesResult {
  /** Unshielded USDC per chain id (raw 6-decimal). */
  unshielded: Record<number, bigint>
  /** Shielded USDC (raw 6-decimal). null = not synced yet. */
  shielded: bigint | null
  /** Yield shares (raw 18-decimal). null = not synced yet. */
  yieldShares: bigint | null
}

export function useBalances(): UseBalancesResult {
  const unshielded = useAtomValue(usdcBalancesAtom)
  const shielded = useAtomValue(shieldedUsdcAtom)
  const yieldShares = useAtomValue(yieldSharesAtom)
  return { unshielded, shielded, yieldShares }
}
