// ABOUTME: Dual-mode wallet hook: Anvil account dropdown (local) or MetaMask (Sepolia).
// ABOUTME: In local mode, uses Anvil private keys directly — no MetaMask import needed.

import { useState, useEffect, useCallback, useMemo } from 'react'
import { BrowserProvider, JsonRpcProvider, Wallet, type Signer } from 'ethers'
import { isSepoliaMode, getHubRpcUrl, getHubChainId } from '../config'
import { ANVIL_ACCOUNTS, type AnvilAccount } from '../config/accounts'

export type WalletMode = 'anvil' | 'metamask'

export interface WalletState {
  /** Current mode */
  mode: WalletMode
  /** Currently active address (from Anvil account or MetaMask) */
  account: string | null
  /** Current chain ID */
  chainId: number | null
  /** Currently selected Anvil account (local mode only) */
  anvilAccount: AnvilAccount | null
  /** All available Anvil accounts */
  anvilAccounts: AnvilAccount[]
  /** Select an Anvil account (local mode) */
  selectAnvilAccount: (account: AnvilAccount) => void
  /** Connect MetaMask (Sepolia mode) */
  connectMetaMask: () => Promise<void>
  /** Disconnect / switch back to Anvil */
  disconnect: () => void
  /** Get an ethers Signer for the current account */
  getSigner: () => Promise<Signer>
}

export function useWallet(): WalletState {
  const [mode, setMode] = useState<WalletMode>(isSepoliaMode() ? 'metamask' : 'anvil')
  const [anvilAccount, setAnvilAccount] = useState<AnvilAccount | null>(
    isSepoliaMode() ? null : ANVIL_ACCOUNTS[0] ?? null,
  )
  const [metaMaskAddress, setMetaMaskAddress] = useState<string | null>(null)
  const [metaMaskChainId, setMetaMaskChainId] = useState<number | null>(null)

  // Derived account based on mode
  const account = mode === 'anvil'
    ? anvilAccount?.address ?? null
    : metaMaskAddress

  const chainId = mode === 'anvil'
    ? getHubChainId()
    : metaMaskChainId

  // Anvil provider (reusable, read-only)
  const anvilProvider = useMemo(
    () => new JsonRpcProvider(getHubRpcUrl()),
    [],
  )

  const selectAnvilAccount = useCallback((acct: AnvilAccount) => {
    setAnvilAccount(acct)
    setMode('anvil')
  }, [])

  const connectMetaMask = useCallback(async () => {
    if (!window.ethereum) {
      alert('MetaMask not found. Please install it.')
      return
    }
    try {
      const provider = new BrowserProvider(window.ethereum)
      const accounts = await provider.send('eth_requestAccounts', [])
      if (accounts.length > 0) {
        setMetaMaskAddress(accounts[0] as string)
      }
      const network = await provider.getNetwork()
      setMetaMaskChainId(Number(network.chainId))
      setMode('metamask')
    } catch (err) {
      console.error('[useWallet] MetaMask connect failed:', err)
    }
  }, [])

  const disconnect = useCallback(() => {
    if (isSepoliaMode()) {
      setMetaMaskAddress(null)
      setMetaMaskChainId(null)
    } else {
      // In local mode, "disconnect" just goes back to Anvil account 0
      setMode('anvil')
      setAnvilAccount(ANVIL_ACCOUNTS[0] ?? null)
    }
  }, [])

  const getSigner = useCallback(async (): Promise<Signer> => {
    if (mode === 'anvil' && anvilAccount) {
      return new Wallet(anvilAccount.privateKey, anvilProvider)
    }
    if (mode === 'metamask' && window.ethereum) {
      const provider = new BrowserProvider(window.ethereum)
      return provider.getSigner()
    }
    throw new Error('No wallet connected')
  }, [mode, anvilAccount, anvilProvider])

  // Listen for MetaMask account and chain changes
  useEffect(() => {
    if (!window.ethereum) return

    const handleAccountsChanged = (accounts: string[]) => {
      if (mode === 'metamask') {
        setMetaMaskAddress(accounts.length > 0 ? (accounts[0] as string) : null)
      }
    }

    const handleChainChanged = (chainIdHex: string) => {
      if (mode === 'metamask') {
        setMetaMaskChainId(parseInt(chainIdHex, 16))
      }
    }

    window.ethereum.on('accountsChanged', handleAccountsChanged)
    window.ethereum.on('chainChanged', handleChainChanged)

    return () => {
      window.ethereum?.removeListener('accountsChanged', handleAccountsChanged)
      window.ethereum?.removeListener('chainChanged', handleChainChanged)
    }
  }, [mode])

  return {
    mode,
    account,
    chainId,
    anvilAccount,
    anvilAccounts: ANVIL_ACCOUNTS,
    selectAnvilAccount,
    connectMetaMask,
    disconnect,
    getSigner,
  }
}

// Extend Window for MetaMask
declare global {
  interface Window {
    ethereum?: any
  }
}
