/**
 * Shared balance utility functions for error checking and display logic
 */

import type { BalanceSyncState, BalanceErrors } from '@/atoms/balanceAtom'

export type BalanceType = 'evm' | 'transparent' | 'shielded'

/**
 * Check if a balance has an error state
 */
export function checkBalanceError(
  balanceSyncState: BalanceSyncState,
  balanceErrors: BalanceErrors,
  balanceType: BalanceType
): boolean {
  switch (balanceType) {
    case 'evm':
      return balanceSyncState.evmStatus === 'error' && !!balanceErrors.evm
    case 'transparent':
      return balanceSyncState.transparentStatus === 'error' && !!balanceErrors.transparent
    case 'shielded':
      return balanceSyncState.shieldedStatus === 'error' && !!balanceErrors.shielded
    default:
      return false
  }
}

/**
 * Format balance for display, handling error states
 */
export function formatBalanceForDisplay(balance: string | undefined, hasError: boolean): string {
  if (hasError) {
    return '--'
  }
  return balance && balance !== '--' ? balance : '--'
}

/**
 * Check if a balance is loading
 */
export function isBalanceLoading(
  syncState: BalanceSyncState,
  balanceType: BalanceType,
  additionalLoadingCondition?: boolean
): boolean {
  switch (balanceType) {
    case 'evm':
      return syncState.status === 'refreshing'
    case 'transparent':
      return syncState.status === 'refreshing'
    case 'shielded':
      return (
        syncState.shieldedStatus === 'calculating' ||
        syncState.shieldedStatus === 'syncing' ||
        (additionalLoadingCondition ?? false)
      )
    default:
      return false
  }
}

/**
 * Check if a balance has a value greater than zero
 */
export function hasBalance(balance: string | undefined): boolean {
  if (!balance || balance === '--') {
    return false
  }
  return parseFloat(balance) > 0
}

