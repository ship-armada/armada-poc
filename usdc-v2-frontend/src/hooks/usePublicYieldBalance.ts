/**
 * Public Yield Balance Hook
 *
 * Fetches the user's public (non-shielded) USDC and ayUSDC balances
 * for use with the Earn panel's direct deposit/withdraw functionality.
 */

import { useState, useEffect, useCallback } from 'react'
import { useAtomValue } from 'jotai'
import { ethers } from 'ethers'
import { walletAtom } from '@/atoms/walletAtom'
import { loadDeployments, getYieldDeployment, getHubChain } from '@/config/deployments'

// ABI for ERC20 balance
const ERC20_ABI = [
  'function balanceOf(address account) external view returns (uint256)',
]

// ABI for vault conversion
const VAULT_ABI = [
  'function balanceOf(address account) external view returns (uint256)',
  'function convertToAssets(uint256 shares) external view returns (uint256)',
]

export interface UsePublicYieldBalanceReturn {
  /** Public USDC balance in base units */
  usdcBalance: bigint
  /** Public ayUSDC shares in base units */
  ayUsdcShares: bigint
  /** USDC equivalent of ayUSDC shares */
  ayUsdcAssets: bigint
  /** Formatted USDC balance */
  formattedUsdc: string
  /** Formatted ayUSDC shares */
  formattedAyUsdcShares: string
  /** Formatted ayUSDC assets (USDC value) */
  formattedAyUsdcAssets: string
  /** Whether user has any yield position */
  hasYieldPosition: boolean
  /** Whether balances are loading */
  isLoading: boolean
  /** Error if any */
  error: string | null
  /** Refresh balances */
  refresh: () => Promise<void>
}

function formatBalance(balance: bigint): string {
  const divisor = 1_000_000n
  const whole = balance / divisor
  const fraction = balance % divisor
  const fractionStr = fraction.toString().padStart(6, '0')
  return `${whole}.${fractionStr.slice(0, 2)}`
}

export function usePublicYieldBalance(): UsePublicYieldBalanceReturn {
  const walletState = useAtomValue(walletAtom)
  const address = walletState.metaMask.account
  const isConnected = walletState.metaMask.isConnected

  const [usdcBalance, setUsdcBalance] = useState<bigint>(0n)
  const [ayUsdcShares, setAyUsdcShares] = useState<bigint>(0n)
  const [ayUsdcAssets, setAyUsdcAssets] = useState<bigint>(0n)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!address || !isConnected) {
      setUsdcBalance(0n)
      setAyUsdcShares(0n)
      setAyUsdcAssets(0n)
      return
    }

    setIsLoading(true)
    setError(null)

    try {
      await loadDeployments()
      const hubChain = getHubChain()
      const yieldDeployment = getYieldDeployment()

      const usdcAddress = hubChain.contracts?.mockUSDC
      const vaultAddress = yieldDeployment?.contracts?.armadaYieldVault

      if (!usdcAddress) {
        throw new Error('USDC address not found')
      }

      const provider = new ethers.JsonRpcProvider('http://localhost:8545')

      // Fetch USDC balance
      const usdc = new ethers.Contract(usdcAddress, ERC20_ABI, provider)
      const usdcBal = await usdc.balanceOf(address)
      setUsdcBalance(usdcBal)

      // Fetch ayUSDC balance if vault is deployed
      let shares = 0n
      if (vaultAddress) {
        const vault = new ethers.Contract(vaultAddress, VAULT_ABI, provider)
        shares = await vault.balanceOf(address)
        setAyUsdcShares(shares)

        // Convert shares to USDC equivalent
        if (shares > 0n) {
          const assets = await vault.convertToAssets(shares)
          setAyUsdcAssets(assets)
        } else {
          setAyUsdcAssets(0n)
        }
      }

      console.log('[public-yield] USDC:', usdcBal.toString(), 'ayUSDC:', shares.toString())
    } catch (err) {
      console.error('[public-yield] Failed to fetch balances:', err)
      setError(err instanceof Error ? err.message : 'Failed to fetch balances')
    } finally {
      setIsLoading(false)
    }
  }, [address, isConnected])

  // Auto-refresh on mount and when address changes
  useEffect(() => {
    refresh()
  }, [refresh])

  // Refresh periodically (every 10 seconds)
  useEffect(() => {
    if (!isConnected) return

    const interval = setInterval(refresh, 10000)
    return () => clearInterval(interval)
  }, [isConnected, refresh])

  return {
    usdcBalance,
    ayUsdcShares,
    ayUsdcAssets,
    formattedUsdc: formatBalance(usdcBalance),
    formattedAyUsdcShares: formatBalance(ayUsdcShares),
    formattedAyUsdcAssets: formatBalance(ayUsdcAssets),
    hasYieldPosition: ayUsdcShares > 0n,
    isLoading,
    error,
    refresh,
  }
}
