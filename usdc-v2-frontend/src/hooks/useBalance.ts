import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { balanceAtom, balanceErrorAtom, balanceSyncAtom } from '@/atoms/balanceAtom'
import {
  requestBalanceRefresh,
  startBalancePolling,
  stopBalancePolling,
  isBalancePollingActive,
  type BalanceRefreshOptions,
} from '@/services/balance/balanceService'

export function useBalance() {
  const [balanceState, setBalanceState] = useAtom(balanceAtom)
  const setBalanceError = useSetAtom(balanceErrorAtom)
  const balanceError = useAtomValue(balanceErrorAtom)
  const balanceSync = useAtomValue(balanceSyncAtom)

  /**
   * Update the EVM USDC balance for the currently connected chain.
   * This should be called when the chain changes or when balance is refreshed.
   */
  function updateEvmBalance(usdc: string, chainKey?: string): void {
    setBalanceState((state) => ({
      ...state,
      evm: {
        usdc,
        chainKey,
        lastUpdated: Date.now(),
      },
    }))
    setBalanceError(undefined)
  }

  /**
   * Update the Namada shielded USDC balance.
   */
  function updateNamadaShieldedBalance(usdc: string): void {
    setBalanceState((state) => ({
      ...state,
      namada: {
        ...state.namada,
        usdcShielded: usdc,
        shieldedLastUpdated: Date.now(),
      },
    }))
    setBalanceError(undefined)
  }

  /**
   * Update the Namada transparent USDC balance.
   */
  function updateNamadaTransparentBalance(usdc: string): void {
    setBalanceState((state) => ({
      ...state,
      namada: {
        ...state.namada,
        usdcTransparent: usdc,
        transparentLastUpdated: Date.now(),
      },
    }))
    setBalanceError(undefined)
  }

  /**
   * Clear the EVM balance (useful when disconnecting or switching chains).
   */
  function clearEvmBalance(): void {
    setBalanceState((state) => ({
      ...state,
      evm: {
        usdc: '--',
        chainKey: undefined,
        lastUpdated: undefined,
      },
    }))
  }

  return {
    state: balanceState,
    error: balanceError,
    sync: balanceSync,
    refresh: (options?: BalanceRefreshOptions) => requestBalanceRefresh({ trigger: 'manual', ...options }),
    startPolling: startBalancePolling,
    stopPolling: stopBalancePolling,
    isPollingActive: isBalancePollingActive,
    updateEvmBalance,
    updateNamadaShieldedBalance,
    updateNamadaTransparentBalance,
    clearEvmBalance,
  }
}

