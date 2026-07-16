/**
 * Yield Rate Hook
 *
 * Provides real-time yield rate updates through a hybrid approach:
 * - Periodic polling (every 30s) for baseline updates
 * - Event-driven updates on vault Deposit/Withdraw events
 *
 * This ensures the dashboard shows accurate yield values even when
 * yield accrues passively without SDK balance update events.
 *
 * The hook updates the yieldRateAtom, which is used by derived atoms
 * in shieldedWalletAtom for real-time balance display.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { useAtom } from 'jotai'
import { ethers } from 'ethers'
import { loadDeployments, getYieldDeployment } from '@/config/deployments'
import { getHubRpcUrl, isSepoliaMode } from '@/config/networkConfig'
import { yieldRateAtom } from '@/atoms/shieldedWalletAtom'

// Vault ABI - only the functions/events we need
const VAULT_ABI = [
  'function convertToAssets(uint256 shares) view returns (uint256)',
  'function totalAssets() view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)',
  'event Withdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares)',
]

// Polling interval in milliseconds
const POLL_INTERVAL_MS = 30_000 // 30 seconds

// Debounce delay for event-driven updates
const EVENT_DEBOUNCE_MS = 500

export interface UseYieldRateReturn {
  /** Current exchange rate (assets per share, scaled by 1e6) */
  exchangeRate: bigint
  /** Last time the rate was updated */
  lastUpdated: Date | null
  /** Whether currently fetching the rate */
  isLoading: boolean
  /** Error if rate fetch failed */
  error: string | null
  /** Manually refresh the rate */
  refresh: () => Promise<void>
  /** Convert shares to assets using current rate */
  convertSharesToAssets: (shares: bigint) => bigint
}

export function useYieldRate(): UseYieldRateReturn {
  const [rateState, setRateState] = useAtom(yieldRateAtom)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Refs for cleanup and debouncing
  const providerRef = useRef<ethers.JsonRpcProvider | null>(null)
  const vaultRef = useRef<ethers.Contract | null>(null)
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null)
  const pollTimerRef = useRef<NodeJS.Timeout | null>(null)

  // Fetch the current exchange rate from the vault
  const fetchExchangeRate = useCallback(async () => {
    try {
      await loadDeployments()
      const yieldDeployment = getYieldDeployment()

      if (!yieldDeployment?.contracts?.armadaYieldVault) {
        // No vault deployed, use 1:1 rate
        return
      }

      const vaultAddress = yieldDeployment.contracts.armadaYieldVault

      // Create provider if needed
      if (!providerRef.current) {
        providerRef.current = new ethers.JsonRpcProvider(getHubRpcUrl())
      }

      // Create vault contract if needed
      if (!vaultRef.current || vaultRef.current.target !== vaultAddress) {
        vaultRef.current = new ethers.Contract(
          vaultAddress,
          VAULT_ABI,
          providerRef.current,
        )
      }

      // Get total assets and total supply to calculate rate
      // Rate = totalAssets / totalSupply (if supply > 0)
      const [totalAssets, totalSupply] = await Promise.all([
        vaultRef.current.totalAssets(),
        vaultRef.current.totalSupply(),
      ])

      if (totalSupply > 0n) {
        // Calculate rate with 6 decimal precision (matching USDC)
        // rate = (totalAssets * 1e6) / totalSupply
        const rate = (totalAssets * 1_000_000n) / totalSupply
        setRateState({ exchangeRate: rate, lastUpdated: new Date() })
      } else {
        // No shares minted yet, 1:1 rate
        setRateState({ exchangeRate: 1_000_000n, lastUpdated: new Date() })
      }

      setError(null)
    } catch (err) {
      console.error('[useYieldRate] Failed to fetch exchange rate:', err)
      setError(err instanceof Error ? err.message : 'Failed to fetch rate')
    }
  }, [])

  // Debounced refresh for event-driven updates
  const debouncedRefresh = useCallback(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
    }

    debounceTimerRef.current = setTimeout(async () => {
      console.log('[useYieldRate] Event-triggered refresh')
      await fetchExchangeRate()
    }, EVENT_DEBOUNCE_MS)
  }, [fetchExchangeRate])

  // Manual refresh (exposed to consumers)
  const refresh = useCallback(async () => {
    setIsLoading(true)
    try {
      await fetchExchangeRate()
    } finally {
      setIsLoading(false)
    }
  }, [fetchExchangeRate])

  // Convert shares to assets using current rate
  const convertSharesToAssets = useCallback(
    (shares: bigint): bigint => {
      if (shares === 0n) return 0n
      // assets = (shares * rate) / 1e6
      return (shares * rateState.exchangeRate) / 1_000_000n
    },
    [rateState.exchangeRate],
  )

  // Set up polling and event listeners
  useEffect(() => {
    let mounted = true

    const setup = async () => {
      try {
        await loadDeployments()
        const yieldDeployment = getYieldDeployment()

        if (!yieldDeployment?.contracts?.armadaYieldVault) {
          console.log('[useYieldRate] No vault deployed, skipping setup')
          return
        }

        const vaultAddress = yieldDeployment.contracts.armadaYieldVault

        // Create provider
        providerRef.current = new ethers.JsonRpcProvider(getHubRpcUrl())

        // Create vault contract
        vaultRef.current = new ethers.Contract(
          vaultAddress,
          VAULT_ABI,
          providerRef.current,
        )

        // Initial fetch
        if (mounted) {
          await fetchExchangeRate()
        }

        // Set up event listeners (skip on Sepolia — public RPCs don't support eth_newFilter)
        if (!isSepoliaMode()) {
          const handleVaultEvent = () => {
            if (mounted) {
              debouncedRefresh()
            }
          }

          vaultRef.current.on('Deposit', handleVaultEvent)
          vaultRef.current.on('Withdraw', handleVaultEvent)

          console.log('[useYieldRate] Listening for vault events at:', vaultAddress)
        }

        // Set up polling
        pollTimerRef.current = setInterval(() => {
          if (mounted) {
            console.log('[useYieldRate] Polling refresh')
            fetchExchangeRate()
          }
        }, POLL_INTERVAL_MS)
      } catch (err) {
        console.error('[useYieldRate] Setup failed:', err)
        if (mounted) {
          setError(err instanceof Error ? err.message : 'Setup failed')
        }
      }
    }

    setup()

    // Cleanup
    return () => {
      mounted = false

      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
      }

      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current)
      }

      if (vaultRef.current) {
        vaultRef.current.removeAllListeners()
      }
    }
  }, [fetchExchangeRate, debouncedRefresh])

  return {
    exchangeRate: rateState.exchangeRate,
    lastUpdated: rateState.lastUpdated,
    isLoading,
    error,
    refresh,
    convertSharesToAssets,
  }
}
