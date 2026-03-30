// ABOUTME: Wallet connection state using ethers v6 BrowserProvider.
// ABOUTME: Connects to window.ethereum (MetaMask etc.) and provides signer.

import { useState, useEffect, useCallback } from 'react'
import { BrowserProvider, JsonRpcSigner } from 'ethers'
import { getHubChainId } from '@/config/network'

export interface UseWalletResult {
  address: string | null
  signer: JsonRpcSigner | null
  chainId: number | null
  connected: boolean
  connecting: boolean
  error: string | null
  connect: () => Promise<void>
  disconnect: () => void
}

export function useWallet(): UseWalletResult {
  const [address, setAddress] = useState<string | null>(null)
  const [signer, setSigner] = useState<JsonRpcSigner | null>(null)
  const [chainId, setChainId] = useState<number | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const connect = useCallback(async () => {
    const ethereum = (window as any).ethereum
    if (!ethereum) {
      setError('No wallet detected. Install MetaMask or another Ethereum wallet.')
      return
    }

    setConnecting(true)
    setError(null)

    try {
      const provider = new BrowserProvider(ethereum)
      await provider.send('eth_requestAccounts', [])
      const s = await provider.getSigner()
      const addr = await s.getAddress()
      const network = await provider.getNetwork()

      setAddress(addr.toLowerCase())
      setSigner(s)
      setChainId(Number(network.chainId))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to connect wallet')
    } finally {
      setConnecting(false)
    }
  }, [])

  const disconnect = useCallback(() => {
    setAddress(null)
    setSigner(null)
    setChainId(null)
    setError(null)
  }, [])

  // Listen for account and chain changes
  useEffect(() => {
    const ethereum = (window as any).ethereum
    if (!ethereum) return

    const handleAccountsChanged = (accounts: string[]) => {
      if (accounts.length === 0) {
        disconnect()
      } else {
        setAddress(accounts[0].toLowerCase())
        // Re-create signer
        const provider = new BrowserProvider(ethereum)
        provider.getSigner().then(setSigner).catch(() => disconnect())
      }
    }

    const handleChainChanged = (chainIdHex: string) => {
      setChainId(parseInt(chainIdHex, 16))
    }

    ethereum.on('accountsChanged', handleAccountsChanged)
    ethereum.on('chainChanged', handleChainChanged)

    return () => {
      ethereum.removeListener('accountsChanged', handleAccountsChanged)
      ethereum.removeListener('chainChanged', handleChainChanged)
    }
  }, [disconnect])

  const expectedChainId = getHubChainId()
  const wrongChain = chainId !== null && chainId !== expectedChainId

  return {
    address,
    signer,
    chainId,
    connected: address !== null && !wrongChain,
    connecting,
    error: wrongChain ? `Wrong network. Please switch to chain ${expectedChainId}.` : error,
    connect,
    disconnect,
  }
}
