// ABOUTME: Wallet connection state using ethers v6 BrowserProvider.
// ABOUTME: Connects to window.ethereum (MetaMask etc.) and provides signer.

import { useState, useEffect, useCallback } from 'react'
import { BrowserProvider, JsonRpcSigner } from 'ethers'
import { getHubChainId, isLocalMode, getHubRpcUrl } from '@/config/network'

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

/** Ask the wallet to switch to the expected chain, adding it if unknown. */
async function ensureCorrectChain(ethereum: any, expectedChainId: number): Promise<void> {
  const hexChainId = '0x' + expectedChainId.toString(16)
  try {
    await ethereum.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: hexChainId }],
    })
  } catch (err: any) {
    // Error 4902: chain not yet added to wallet — add it then retry
    if (err?.code === 4902) {
      await ethereum.request({
        method: 'wallet_addEthereumChain',
        params: [{
          chainId: hexChainId,
          chainName: isLocalMode() ? 'Anvil (Local)' : 'Sepolia',
          nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
          rpcUrls: [getHubRpcUrl()],
          ...(isLocalMode() ? {} : { blockExplorerUrls: ['https://sepolia.etherscan.io'] }),
        }],
      })
    } else {
      throw err
    }
  }
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

      // Switch to the expected chain if the wallet is on a different one
      const network = await provider.getNetwork()
      const expectedChainId = getHubChainId()
      if (Number(network.chainId) !== expectedChainId) {
        await ensureCorrectChain(ethereum, expectedChainId)
      }

      // Re-create provider after potential chain switch
      const finalProvider = new BrowserProvider(ethereum)
      const s = await finalProvider.getSigner()
      const addr = await s.getAddress()
      const finalNetwork = await finalProvider.getNetwork()

      setAddress(addr.toLowerCase())
      setSigner(s)
      setChainId(Number(finalNetwork.chainId))
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

  useEffect(() => {
    const ethereum = (window as any).ethereum
    if (!ethereum) return

    const handleAccountsChanged = (accounts: string[]) => {
      if (accounts.length === 0) {
        disconnect()
      } else {
        setAddress(accounts[0].toLowerCase())
        const provider = new BrowserProvider(ethereum)
        provider.getSigner().then(setSigner).catch(() => disconnect())
      }
    }

    const handleChainChanged = (chainIdHex: string) => {
      const newChainId = parseInt(chainIdHex, 16)
      setChainId(newChainId)
      // Re-acquire signer after chain switch so it targets the new chain
      const provider = new BrowserProvider(ethereum)
      provider.getSigner().then(setSigner).catch(() => disconnect())
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
