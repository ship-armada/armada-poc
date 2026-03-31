// ABOUTME: Wallet connection state wrapping wagmi hooks.
// ABOUTME: Provides ethers Signer via adapter for backwards compatibility.

import { useMemo } from 'react'
import { useAccount, useChainId, useWalletClient, useDisconnect } from 'wagmi'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { walletClientToSigner } from '@/lib/wagmiAdapter'
import { getHubChainId } from '@/config/network'
import type { JsonRpcSigner } from 'ethers'

export interface UseWalletResult {
  address: string | null
  signer: JsonRpcSigner | null
  chainId: number | null
  connected: boolean
  connecting: boolean
  error: string | null
  connect: () => void
  disconnect: () => void
}

export function useWallet(): UseWalletResult {
  const { address: rawAddress, isConnected, isConnecting } = useAccount()
  const chainId = useChainId()
  const { data: walletClient } = useWalletClient()
  const { openConnectModal } = useConnectModal()
  const { disconnect: wagmiDisconnect } = useDisconnect()

  const expectedChainId = getHubChainId()
  const wrongChain = isConnected && chainId !== expectedChainId

  const signer = useMemo(() => {
    if (!walletClient || wrongChain) return null
    try {
      return walletClientToSigner(walletClient)
    } catch {
      return null
    }
  }, [walletClient, wrongChain])

  return {
    address: rawAddress ? rawAddress.toLowerCase() : null,
    signer,
    chainId: chainId ?? null,
    connected: isConnected && !wrongChain,
    connecting: isConnecting,
    error: wrongChain ? `Wrong network. Please switch to chain ${expectedChainId}.` : null,
    connect: () => openConnectModal?.(),
    disconnect: () => wagmiDisconnect(),
  }
}
