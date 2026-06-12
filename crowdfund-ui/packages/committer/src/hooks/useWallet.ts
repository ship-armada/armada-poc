// ABOUTME: Wallet connection state wrapping wagmi hooks.
// ABOUTME: Provides ethers Signer via adapter for backwards compatibility.

import { useCallback, useMemo } from 'react'
import { useAccount, useWalletClient, useDisconnect, useSwitchChain } from 'wagmi'
import { useConnectModal, useChainModal } from '@rainbow-me/rainbowkit'
import { walletClientToSigner } from '@/lib/wagmiAdapter'
import { getHubChainId } from '@/config/network'
import type { JsonRpcSigner } from 'ethers'

export interface UseWalletResult {
  address: string | null
  signer: JsonRpcSigner | null
  chainId: number | null
  connected: boolean
  connecting: boolean
  isWrongNetwork: boolean
  error: string | null
  connect: () => void
  disconnect: () => void
  switchNetwork: () => void
}

export function useWallet(): UseWalletResult {
  const { address: rawAddress, isConnected, isConnecting, chainId: accountChainId } = useAccount()
  const { data: walletClient } = useWalletClient()
  const { openConnectModal } = useConnectModal()
  const { openChainModal } = useChainModal()
  const { disconnect: wagmiDisconnect } = useDisconnect()
  const { switchChainAsync } = useSwitchChain()

  const expectedChainId = getHubChainId()
  // Detect the wrong network from `useAccount().chainId` (the per-connection
  // value, which tracks the wallet's actual chain) rather than `useChainId()`.
  // With a single-chain config, `useChainId()` always returns the configured
  // chain id and silently ignores a wallet switch to an unconfigured chain, so
  // a mid-session switch to the wrong network would never be detected.
  const isWrongNetwork =
    isConnected && accountChainId !== undefined && accountChainId !== expectedChainId

  const signer = useMemo(() => {
    if (!walletClient || isWrongNetwork) return null
    try {
      return walletClientToSigner(walletClient)
    } catch {
      return null
    }
  }, [walletClient, isWrongNetwork])

  // One-click switch to the hub chain via wagmi. If the connector can't switch
  // programmatically, fall back to RainbowKit's chain modal so the user can
  // switch manually. A plain user rejection is left alone (no modal).
  const switchNetwork = useCallback(() => {
    if (!switchChainAsync) {
      openChainModal?.()
      return
    }
    switchChainAsync({ chainId: expectedChainId }).catch((err: unknown) => {
      if (err instanceof Error && err.name === 'SwitchChainNotSupportedError') {
        openChainModal?.()
      }
    })
  }, [switchChainAsync, expectedChainId, openChainModal])

  return {
    address: rawAddress ? rawAddress.toLowerCase() : null,
    signer,
    chainId: accountChainId ?? null,
    connected: isConnected && !isWrongNetwork,
    connecting: isConnecting,
    isWrongNetwork,
    error: isWrongNetwork ? `Wrong network. Please switch to chain ${expectedChainId}.` : null,
    connect: () => openConnectModal?.(),
    disconnect: () => wagmiDisconnect(),
    switchNetwork,
  }
}
