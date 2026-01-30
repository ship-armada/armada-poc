import { useEffect, useRef } from 'react'
import { useAtomValue } from 'jotai'
import { useWallet } from '@/hooks/useWallet'
import { useBalance } from '@/hooks/useBalance'
import { balanceSyncAtom, balanceErrorsAtom } from '@/atoms/balanceAtom'
import { checkBalanceError, formatBalanceForDisplay } from '@/utils/balanceHelpers'
import type { BalanceRefreshOptions } from '@/services/balance/balanceService'

export interface UseDepositBalanceReturn {
  availableBalance: string
  hasEvmError: boolean
  refreshBalance: (options?: BalanceRefreshOptions) => Promise<void>
}

/**
 * Hook to manage balance fetching and display for deposit flow
 */
export function useDepositBalance(selectedChain: string | undefined): UseDepositBalanceReturn {
  const { state: walletState } = useWallet()
  const { state: balanceState, refresh } = useBalance()
  const balanceSyncState = useAtomValue(balanceSyncAtom)
  const balanceErrors = useAtomValue(balanceErrorsAtom)

  // Track last refresh values to prevent unnecessary refreshes
  const lastRefreshRef = useRef<{
    account?: string
    chainId?: number
  }>({})

  // Store refresh function in ref to avoid dependency issues
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh

  // Refresh balance when wallet connects or chain changes (only if values actually changed)
  useEffect(() => {
    const currentAccount = walletState.metaMask.account
    const currentChainId = walletState.metaMask.chainId
    const lastAccount = lastRefreshRef.current.account
    const lastChainId = lastRefreshRef.current.chainId

    // Only refresh if account or chainId actually changed
    if (
      walletState.metaMask.isConnected &&
      currentAccount &&
      (currentAccount !== lastAccount || currentChainId !== lastChainId)
    ) {
      lastRefreshRef.current = {
        account: currentAccount,
        chainId: currentChainId,
      }
      // Balance service will determine chain key from chainId automatically
      // Only fetch EVM balance (not Namada balances)
      void refreshRef.current({ balanceTypes: ['evm'] })
    }
  }, [
    walletState.metaMask.isConnected,
    walletState.metaMask.account,
    walletState.metaMask.chainId,
  ])

  // Refresh balance when selectedChain changes (for dropdown selection)
  useEffect(() => {
    if (walletState.metaMask.isConnected && walletState.metaMask.account && selectedChain) {
      // Refresh balance with the selected chain key
      // Only fetch EVM balance (not Namada balances)
      void refreshRef.current({ chainKey: selectedChain, balanceTypes: ['evm'] })
    }
  }, [selectedChain, walletState.metaMask.isConnected, walletState.metaMask.account])

  // Get live EVM balance from balance state
  // Check for EVM balance error state
  const hasEvmError = checkBalanceError(balanceSyncState, balanceErrors, 'evm')
  const evmBalance = balanceState.evm.usdc
  const availableBalance = formatBalanceForDisplay(evmBalance, hasEvmError)

  return {
    availableBalance,
    hasEvmError,
    refreshBalance: refreshRef.current,
  }
}

