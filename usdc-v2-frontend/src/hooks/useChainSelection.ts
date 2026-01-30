/**
 * Generic hook for chain selection with configurable strategies
 */

import { useState, useEffect } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { preferredChainKeyAtom } from '@/atoms/appAtom'
import { fetchEvmChainsConfig } from '@/services/config/chainConfigService'
import { findChainByChainId, getDefaultChainKey } from '@/config/chains'
import { useWallet } from '@/hooks/useWallet'

export type ChainSelectionStrategy = 'preferred' | 'metamask' | 'default'

export interface UseChainSelectionOptions {
  /** Strategy for selecting the initial chain */
  strategy?: ChainSelectionStrategy
  /** Whether to update preferredChainKeyAtom when chain changes */
  updatePreferred?: boolean
  /** Whether to use MetaMask chainId as fallback (only for 'preferred' strategy) */
  useMetaMaskFallback?: boolean
}

export interface UseChainSelectionReturn {
  selectedChain: string | undefined
  chainName: string
  setSelectedChain: (chain: string | undefined) => void
}

/**
 * Generic hook for chain selection
 * 
 * @param options - Chain selection configuration
 * @returns Chain selection state and controls
 */
export function useChainSelection(
  options: UseChainSelectionOptions = {}
): UseChainSelectionReturn {
  const {
    strategy = 'default',
    updatePreferred = false,
    useMetaMaskFallback = false,
  } = options

  const { state: walletState } = useWallet()
  const preferredChainKey = useAtomValue(preferredChainKeyAtom)
  const setPreferredChainKey = useSetAtom(preferredChainKeyAtom)
  const [selectedChain, setSelectedChain] = useState<string | undefined>(undefined)
  const [chainName, setChainName] = useState('')

  // Load chain based on strategy
  useEffect(() => {
    let mounted = true

    async function loadChain() {
      try {
        let chainKey: string | undefined

        if (strategy === 'preferred') {
          // 1. First check if preferredChainKeyAtom has a value
          if (preferredChainKey) {
            chainKey = preferredChainKey
          } else if (useMetaMaskFallback) {
            // 2. Try to derive from MetaMask chainId
            const config = await fetchEvmChainsConfig()
            if (walletState.metaMask.isConnected && walletState.metaMask.chainId && config) {
              const chain = findChainByChainId(config, walletState.metaMask.chainId)
              if (chain) {
                chainKey = chain.key
                // Set preferredChainKeyAtom when deriving from MetaMask
                if (mounted) {
                  setPreferredChainKey(chainKey)
                }
              }
            }

            // 3. Fall back to default chain from config
            if (!chainKey) {
              const config = await fetchEvmChainsConfig()
              if (config) {
                chainKey = getDefaultChainKey(config)
              }
            }
          }
        } else if (strategy === 'metamask') {
          // Use MetaMask chainId
          const config = await fetchEvmChainsConfig()
          if (walletState.metaMask.isConnected && walletState.metaMask.chainId && config) {
            const chain = findChainByChainId(config, walletState.metaMask.chainId)
            if (chain) {
              chainKey = chain.key
            }
          }
        } else {
          // 'default' strategy: use default from config
          const config = await fetchEvmChainsConfig()
          if (config?.defaults?.selectedChainKey) {
            chainKey = config.defaults.selectedChainKey
          } else if (config) {
            chainKey = getDefaultChainKey(config)
          }
        }

        // Set selectedChain if we have a chainKey
        if (mounted && chainKey) {
          setSelectedChain(chainKey)
        }
      } catch (error) {
        console.error('[useChainSelection] Failed to load chain:', error)
      }
    }

    void loadChain()

    return () => {
      mounted = false
    }
  }, [
    strategy,
    preferredChainKey,
    useMetaMaskFallback,
    walletState.metaMask.isConnected,
    walletState.metaMask.chainId,
    setPreferredChainKey,
  ])

  // Get chain name for display
  useEffect(() => {
    let mounted = true

    async function loadChainName() {
      try {
        const config = await fetchEvmChainsConfig()
        if (mounted) {
          const chain = config.chains.find((c) => c.key === selectedChain)
          setChainName(chain?.name ?? selectedChain ?? '')
        }
      } catch (error) {
        console.error('[useChainSelection] Failed to load chain name:', error)
        if (mounted) {
          setChainName(selectedChain ?? '')
        }
      }
    }

    if (selectedChain) {
      void loadChainName()
    }

    return () => {
      mounted = false
    }
  }, [selectedChain])

  // Set preferred chain key when selectedChain changes (if enabled)
  useEffect(() => {
    if (updatePreferred && selectedChain) {
      setPreferredChainKey(selectedChain)
    }
  }, [selectedChain, updatePreferred, setPreferredChainKey])

  return {
    selectedChain,
    chainName,
    setSelectedChain,
  }
}

