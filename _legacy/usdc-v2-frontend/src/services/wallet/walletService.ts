import type { WalletConnection } from '@/types/wallet'
import { emitWalletEvent } from '@/services/wallet/walletEvents'
import { jotaiStore } from '@/store/jotaiStore'
import { walletAtom, walletErrorAtom } from '@/atoms/walletAtom'

interface EthereumProvider {
  isMetaMask?: boolean
  request(args: { method: string; params?: unknown[] }): Promise<unknown>
  on?(event: string, handler: (...args: unknown[]) => void): void
  removeListener?(event: string, handler: (...args: unknown[]) => void): void
}

interface MetaMaskConnectOptions {
  chainIdHex?: string
}

let ethereumListenersRegistered = false

function resolveEthereumProvider(): EthereumProvider | undefined {
  if (typeof window === 'undefined') return undefined
  const provider = window.ethereum as EthereumProvider | undefined
  if (!provider || typeof provider.request !== 'function') {
    return undefined
  }
  return provider
}

export function isMetaMaskAvailable(): boolean {
  return Boolean(resolveEthereumProvider())
}

export async function connectMetaMask(options: MetaMaskConnectOptions = {}): Promise<WalletConnection> {
  const provider = resolveEthereumProvider()
  if (!provider) {
    throw new Error('MetaMask is not available in this browser. Please install the extension.')
  }

  registerEthereumEventBridge(provider)

  const accounts = (await provider.request({ method: 'eth_requestAccounts' })) as string[] | undefined
  if (!accounts || accounts.length === 0) {
    throw new Error('MetaMask did not return any accounts. Please ensure an account is unlocked.')
  }

  const { chainId, chainIdHex } = await ensureChain(provider, options.chainIdHex)

  emitWalletEvent('evm:accountsChanged', { accounts })

  return {
    evm: {
      address: accounts[0],
      chainId,
      chainIdHex,
    },
    connectedAt: Date.now(),
  }
}

export async function disconnectMetaMask(): Promise<void> {
  emitWalletEvent('evm:disconnected', { error: undefined })
  // Attempt to revoke permissions if MetaMask supports it
  const provider = resolveEthereumProvider()
  if (provider) {
    try {
      await provider.request({
        method: 'wallet_revokePermissions',
        params: [{ eth_accounts: {} }],
      } as any)
    } catch {
      // Ignore if revoke is not supported
    }
  }
}

export async function disconnectWallets(): Promise<void> {
  await disconnectMetaMask()
}

/**
 * Attempts to silently reconnect to MetaMask if already connected.
 * Uses eth_accounts (non-interactive) to check for existing connections.
 * Directly updates wallet atom and emits events to sync state without prompting the user.
 */
export async function attemptMetaMaskReconnection(): Promise<void> {
  const provider = resolveEthereumProvider()
  if (!provider) {
    return // MetaMask not available, silently skip
  }

  try {
    // Register event bridge first so we can listen to future changes
    registerEthereumEventBridge(provider)

    // Use eth_accounts (non-interactive) to check for existing connections
    const accounts = (await provider.request({ method: 'eth_accounts' })) as string[] | undefined

    if (!accounts || accounts.length === 0) {
      return // No existing connection, silently skip
    }

    // Get current chain info
    const chainIdHex = (await provider.request({ method: 'eth_chainId' })) as string
    const chainId = parseChainId(chainIdHex)

    // Directly update wallet atom (works even if React components haven't mounted yet)
    jotaiStore.set(walletAtom, (state) => ({
      ...state,
      metaMask: {
        ...state.metaMask,
        isConnecting: false,
        isConnected: true,
        account: accounts[0],
        chainId,
        chainHex: chainIdHex,
      },
      lastUpdated: Date.now(),
    }))
    jotaiStore.set(walletErrorAtom, undefined)

    // Also emit events for any listeners that are already registered
    emitWalletEvent('evm:accountsChanged', { accounts })
    emitWalletEvent('evm:chainChanged', { chainIdHex })

    console.info('[WalletService] MetaMask reconnected on startup', {
      account: accounts[0],
      chainId,
    })
  } catch (error) {
    // Silently fail - don't block app initialization
    console.warn('[WalletService] Failed to reconnect MetaMask on startup', error)
  }
}

async function ensureChain(provider: EthereumProvider, desiredChainIdHex?: string): Promise<{ chainId: number | undefined; chainIdHex: string }>
{
  const currentChainIdHex = (await provider.request({ method: 'eth_chainId' })) as string
  if (!desiredChainIdHex || desiredChainIdHex.toLowerCase() === currentChainIdHex.toLowerCase()) {
    return {
      chainId: parseChainId(currentChainIdHex),
      chainIdHex: currentChainIdHex,
    }
  }

  try {
    await provider.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: desiredChainIdHex }],
    })
  } catch (error) {
    console.warn('Failed to switch MetaMask chain', error)
  }

  const updatedChainIdHex = (await provider.request({ method: 'eth_chainId' })) as string
  return {
    chainId: parseChainId(updatedChainIdHex),
    chainIdHex: updatedChainIdHex,
  }
}

function parseChainId(chainIdHex: string | number | undefined): number | undefined {
  if (typeof chainIdHex === 'number') return chainIdHex
  if (typeof chainIdHex !== 'string') return undefined
  const normalized = chainIdHex.startsWith('0x') ? chainIdHex : `0x${chainIdHex}`
  const parsed = Number.parseInt(normalized, 16)
  return Number.isNaN(parsed) ? undefined : parsed
}

function registerEthereumEventBridge(provider: EthereumProvider): void {
  if (ethereumListenersRegistered) return

  provider.on?.('accountsChanged', (...args: unknown[]) => {
    const accounts = args[0] as string[]
    emitWalletEvent('evm:accountsChanged', { accounts })
  })

  provider.on?.('chainChanged', (...args: unknown[]) => {
    const chainIdHex = args[0] as string
    emitWalletEvent('evm:chainChanged', { chainIdHex })
  })

  provider.on?.('disconnect', (...args: unknown[]) => {
    const error = args[0] as unknown
    emitWalletEvent('evm:disconnected', { error })
  })

  ethereumListenersRegistered = true
}

declare global {
  interface Window {
    ethereum?: EthereumProvider
  }
}
