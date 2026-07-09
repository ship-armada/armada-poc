import { useAtomValue } from 'jotai'
import { balanceSyncAtom, balanceErrorsAtom } from '@/atoms/balanceAtom'
import type { BalanceState } from '@/atoms/balanceAtom'

interface UseBalanceDisplayOptions {
  /** Balance state from useBalance hook */
  balanceState: BalanceState
  /** Shielded sync state (for loading state) */
  shieldedState?: {
    isSyncing: boolean
  }
}

interface BalanceDisplayResult {
  /** Shielded balance value */
  shieldedBalance: string | undefined
  /** Transparent balance value */
  transparentBalance: string | undefined
  /** Display value for shielded balance (with error handling) */
  displayShieldedBalance: string | undefined
  /** Display value for transparent balance (with error handling) */
  displayTransparentBalance: string | undefined
  /** Whether shielded balance has an error */
  hasShieldedError: boolean
  /** Whether transparent balance has an error */
  hasTransparentError: boolean
  /** Whether shielded balance is loading */
  isShieldedBalanceLoading: boolean
  /** Whether there is a transparent balance > 0 */
  hasTransparentBalance: boolean
  /** Whether there is a shielded balance > 0 */
  hasShieldedBalance: boolean
}

/**
 * Hook to centralize balance display logic with error handling
 * 
 * Provides consistent balance display logic used across Dashboard and Sidebar components.
 * Handles error states, loading states, and balance formatting.
 * 
 * @param options - Balance display options
 * @returns Balance display values and state flags
 */
export function useBalanceDisplay({
  balanceState,
  shieldedState,
}: UseBalanceDisplayOptions): BalanceDisplayResult {
  const balanceSyncState = useAtomValue(balanceSyncAtom)
  const balanceErrors = useAtomValue(balanceErrorsAtom)

  // Get balances from the balance state
  const shieldedBalance = balanceState.namada.usdcShielded
  const transparentBalance = balanceState.namada.usdcTransparent
  const hasTransparentBalance = parseFloat(transparentBalance || '0') > 0

  // Check for balance calculation error states
  const hasShieldedError = !!(balanceSyncState.shieldedStatus === 'error' && balanceErrors.shielded)
  const hasTransparentError = !!(balanceSyncState.transparentStatus === 'error' && balanceErrors.transparent)

  const displayShieldedBalance = hasShieldedError ? '--' : shieldedBalance
  const displayTransparentBalance = hasTransparentError ? '--' : transparentBalance
  const hasShieldedBalance = !!(displayShieldedBalance && displayShieldedBalance !== '--' && parseFloat(displayShieldedBalance) > 0)

  // Check if shielded balance is loading (sync or calculation in progress)
  const isShieldedBalanceLoading = shieldedState
    ? (shieldedState.isSyncing || balanceSyncState.shieldedStatus === 'calculating')
    : balanceSyncState.shieldedStatus === 'calculating'

  return {
    shieldedBalance,
    transparentBalance,
    displayShieldedBalance,
    displayTransparentBalance,
    hasShieldedError,
    hasTransparentError,
    isShieldedBalanceLoading,
    hasTransparentBalance,
    hasShieldedBalance,
  }
}
