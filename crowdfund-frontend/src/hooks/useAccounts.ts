// ABOUTME: Account switching hook for both Anvil (local) and MetaMask (Sepolia).
// ABOUTME: Provides signer, provider, address, and admin detection.
import { useCallback, useEffect, useMemo } from 'react'
import { useAtom, useAtomValue } from 'jotai'
import { JsonRpcProvider, Wallet, BrowserProvider, type Signer, type Provider } from 'ethers'
import { walletAtom, currentAddressAtom } from '@/atoms/wallet'
import { deploymentAtom } from '@/atoms/crowdfund'
import { ANVIL_ACCOUNTS, type AnvilAccount } from '@/config/accounts'
import { getHubRpcUrl, getHubChainId, isLocalMode } from '@/config/network'

export function useAccounts() {
  const [wallet, setWallet] = useAtom(walletAtom)
  const currentAddress = useAtomValue(currentAddressAtom)
  const deployment = useAtomValue(deploymentAtom)

  const provider = useMemo<Provider>(() => {
    return new JsonRpcProvider(getHubRpcUrl())
  }, [])

  const signer = useMemo<Signer | null>(() => {
    if (wallet.mode === 'anvil' && wallet.anvilAccount) {
      return new Wallet(wallet.anvilAccount.privateKey, provider as JsonRpcProvider)
    }
    // MetaMask signer is created asynchronously, handled separately
    return null
  }, [wallet.mode, wallet.anvilAccount, provider])

  const isLaunchTeam = useMemo(() => {
    if (!currentAddress || !deployment) return false
    return currentAddress.toLowerCase() === deployment.deployer.toLowerCase()
  }, [currentAddress, deployment])

  const selectAnvilAccount = useCallback((account: AnvilAccount) => {
    setWallet((prev) => ({
      ...prev,
      mode: 'anvil',
      anvilAccount: account,
    }))
  }, [setWallet])

  const connectMetaMask = useCallback(async () => {
    if (typeof window === 'undefined' || !window.ethereum) {
      throw new Error('MetaMask not installed')
    }

    setWallet((prev) => ({ ...prev, isConnecting: true }))

    try {
      const accounts = await window.ethereum.request({
        method: 'eth_requestAccounts',
      }) as string[]

      const chainId = await window.ethereum.request({
        method: 'eth_chainId',
      }) as string

      setWallet((prev) => ({
        ...prev,
        mode: 'metamask',
        metaMaskAddress: accounts[0] ?? null,
        metaMaskChainId: parseInt(chainId, 16),
        isConnecting: false,
      }))

      // Switch to the correct chain if needed
      const targetChainId = getHubChainId()
      if (parseInt(chainId, 16) !== targetChainId) {
        try {
          await window.ethereum.request({
            method: 'wallet_switchEthereumChain',
            params: [{ chainId: `0x${targetChainId.toString(16)}` }],
          })
        } catch {
          // Chain not added — will need manual add for local Anvil
        }
      }
    } catch {
      setWallet((prev) => ({ ...prev, isConnecting: false }))
    }
  }, [setWallet])

  const disconnectMetaMask = useCallback(() => {
    setWallet((prev) => ({
      ...prev,
      mode: 'anvil',
      metaMaskAddress: null,
      metaMaskChainId: null,
    }))
  }, [setWallet])

  /** Get a MetaMask signer (async because BrowserProvider.getSigner is async) */
  const getMetaMaskSigner = useCallback(async (): Promise<Signer | null> => {
    if (wallet.mode !== 'metamask' || !window.ethereum) return null
    const browserProvider = new BrowserProvider(window.ethereum)
    return browserProvider.getSigner()
  }, [wallet.mode])

  /** Get the active signer (Anvil sync, MetaMask async) */
  const getActiveSigner = useCallback(async (): Promise<Signer | null> => {
    if (wallet.mode === 'anvil') return signer
    return getMetaMaskSigner()
  }, [wallet.mode, signer, getMetaMaskSigner])

  // Listen for MetaMask account/chain changes
  useEffect(() => {
    if (typeof window === 'undefined' || !window.ethereum) return

    const handleAccountsChanged = (accounts: string[]) => {
      setWallet((prev) => ({
        ...prev,
        metaMaskAddress: accounts[0] ?? null,
      }))
    }

    const handleChainChanged = (chainId: string) => {
      setWallet((prev) => ({
        ...prev,
        metaMaskChainId: parseInt(chainId, 16),
      }))
    }

    window.ethereum.on?.('accountsChanged', handleAccountsChanged)
    window.ethereum.on?.('chainChanged', handleChainChanged)

    return () => {
      window.ethereum?.removeListener?.('accountsChanged', handleAccountsChanged)
      window.ethereum?.removeListener?.('chainChanged', handleChainChanged)
    }
  }, [setWallet])

  // Auto-select first Anvil account in local mode
  useEffect(() => {
    if (isLocalMode() && !wallet.anvilAccount) {
      selectAnvilAccount(ANVIL_ACCOUNTS[0])
    }
  }, [wallet.anvilAccount, selectAnvilAccount])

  return {
    wallet,
    currentAddress,
    provider,
    signer,
    isLaunchTeam,
    selectAnvilAccount,
    connectMetaMask,
    disconnectMetaMask,
    getActiveSigner,
    anvilAccounts: ANVIL_ACCOUNTS,
  }
}
