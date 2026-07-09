import { useCallback, useEffect } from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { walletAtom, walletErrorAtom } from '@/atoms/walletAtom'
import {
  connectMetaMask as connectMetaMaskService,
  disconnectMetaMask as disconnectMetaMaskService,
  disconnectWallets,
  isMetaMaskAvailable,
} from '@/services/wallet/walletService'
import { onWalletEvent, offWalletEvent } from '@/services/wallet/walletEvents'
import { useToast } from '@/hooks/useToast'
import {
  buildWalletConnectionToast,
  buildNetworkChangeToast,
} from '@/utils/toastHelpers'

function formatAddress(address: string, startLength = 6, endLength = 4): string {
  if (address.length <= startLength + endLength) return address
  return `${address.slice(0, startLength)}...${address.slice(-endLength)}`
}

export function useWallet() {
  const [walletState, setWalletState] = useAtom(walletAtom)
  const setWalletError = useSetAtom(walletErrorAtom)
  const walletError = useAtomValue(walletErrorAtom)
  const metaMaskAvailable = isMetaMaskAvailable()
  const { notify } = useToast()

  useEffect(() => {
    function handleEvmAccountsChanged(payload: { accounts: string[] }) {
      const isNowConnected = payload.accounts.length > 0
      const account = payload.accounts[0]

      let wasConnected = false
      let previousAccount: string | undefined

      setWalletState((state) => {
        wasConnected = state.metaMask.isConnected
        previousAccount = state.metaMask.account
        return {
          ...state,
          metaMask: {
            ...state.metaMask,
            isConnecting: false,
            isConnected: isNowConnected,
            account,
          },
          lastUpdated: Date.now(),
        }
      })
      setWalletError(undefined)

      if (isNowConnected && account) {
        if (!wasConnected) {
          notify(buildWalletConnectionToast('metamask', account, true))
        } else if (account !== previousAccount) {
          notify({
            title: 'MetaMask Account Changed',
            description: `Switched to: ${formatAddress(account)}`,
            level: 'info',
          })
        }
      } else if (wasConnected) {
        notify(buildWalletConnectionToast('metamask', '', false))
      }
    }

    function handleEvmChainChanged(payload: { chainIdHex: string }) {
      const chainId = Number.parseInt(payload.chainIdHex, 16)
      let previousChainHex: string | undefined
      let wasConnected = false

      setWalletState((state) => {
        previousChainHex = state.metaMask.chainHex
        wasConnected = state.metaMask.isConnected
        return {
          ...state,
          metaMask: {
            ...state.metaMask,
            isConnecting: false,
            chainHex: payload.chainIdHex,
            chainId: Number.isNaN(chainId) ? state.metaMask.chainId : chainId,
          },
          lastUpdated: Date.now(),
        }
      })

      // Only show toast if chain actually changed (not on initial connection)
      if (wasConnected && previousChainHex && previousChainHex !== payload.chainIdHex) {
        notify(buildNetworkChangeToast(chainId))
      }
    }

    function handleEvmDisconnected() {
      let wasConnected = false
      setWalletState((state) => {
        wasConnected = state.metaMask.isConnected
        return {
          ...state,
          metaMask: {
            isConnecting: false,
            isConnected: false,
            account: undefined,
            chainId: undefined,
            chainHex: undefined,
          },
          lastUpdated: Date.now(),
        }
      })
      setWalletError(undefined)

      if (wasConnected) {
        notify(buildWalletConnectionToast('metamask', '', false))
      }
    }

    onWalletEvent('evm:accountsChanged', handleEvmAccountsChanged)
    onWalletEvent('evm:chainChanged', handleEvmChainChanged)
    onWalletEvent('evm:disconnected', handleEvmDisconnected)

    return () => {
      offWalletEvent('evm:accountsChanged', handleEvmAccountsChanged)
      offWalletEvent('evm:chainChanged', handleEvmChainChanged)
      offWalletEvent('evm:disconnected', handleEvmDisconnected)
    }
  }, [setWalletError, setWalletState, notify])

  const connectMetaMask = useCallback(async () => {
    setWalletState((state) => ({
      ...state,
      metaMask: { ...state.metaMask, isConnecting: true },
    }))
    try {
      const connection = await connectMetaMaskService()
      setWalletState((state) => ({
        ...state,
        metaMask: {
          ...state.metaMask,
          isConnecting: false,
          isConnected: true,
          account: connection.evm?.address,
          chainId: connection.evm?.chainId,
          chainHex: connection.evm?.chainIdHex,
        },
        lastUpdated: connection.connectedAt,
      }))
      setWalletError(undefined)
      // Success toast will be shown by the event handler
    } catch (error) {
      console.error('MetaMask connection failed', error)
      const message = error instanceof Error ? error.message : 'Unable to connect MetaMask'
      setWalletError(message)
      setWalletState((state) => ({
        ...state,
        metaMask: { ...state.metaMask, isConnecting: false },
      }))
      notify({
        title: 'MetaMask Connection Failed',
        description: message,
        level: 'error',
      })
    }
  }, [setWalletError, setWalletState, notify])

  const disconnectMetaMask = useCallback(async () => {
    setWalletState((state) => ({
      ...state,
      metaMask: { ...state.metaMask, isConnecting: true },
    }))
    try {
      await disconnectMetaMaskService()
    } finally {
      setWalletState((state) => ({
        ...state,
        metaMask: {
          isConnecting: false,
          isConnected: false,
          account: undefined,
          chainId: undefined,
          chainHex: undefined,
        },
        lastUpdated: Date.now(),
      }))
      setWalletError(undefined)
    }
  }, [setWalletError, setWalletState])

  const disconnect = useCallback(async () => {
    setWalletState((state) => ({
      ...state,
      metaMask: { ...state.metaMask, isConnecting: true },
    }))
    try {
      await disconnectWallets()
    } finally {
      setWalletState({
        metaMask: {
          isConnecting: false,
          isConnected: false,
          account: undefined,
          chainId: undefined,
          chainHex: undefined,
        },
        lastUpdated: Date.now(),
      })
      setWalletError(undefined)
    }
  }, [setWalletError, setWalletState])

  return {
    state: walletState,
    error: walletError,
    isMetaMaskAvailable: metaMaskAvailable,
    connectMetaMask,
    disconnectMetaMask,
    disconnect,
  }
}
