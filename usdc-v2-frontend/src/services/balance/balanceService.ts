import { jotaiStore } from '@/store/jotaiStore'
import { balanceAtom, balanceErrorAtom, balanceSyncAtom, balanceErrorsAtom } from '@/atoms/balanceAtom'
import { walletAtom } from '@/atoms/walletAtom'
import { chainConfigAtom, preferredChainKeyAtom } from '@/atoms/appAtom'
import { fetchEvmUsdcBalance } from '@/services/balance/evmBalanceService'
import { findChainByChainId, findChainByKey, getDefaultChainKey } from '@/config/chains'

const DEFAULT_POLL_INTERVAL_MS = 10_000

type BalanceRefreshTrigger = 'init' | 'manual' | 'poll'

export type BalanceType = 'evm'

export interface BalanceRefreshOptions {
  trigger?: BalanceRefreshTrigger
  chainKey?: string
  /**
   * Optional array of balance types to fetch. If not provided, all balance types will be fetched.
   * This allows selective refresh of specific balance types for better performance.
   */
  balanceTypes?: BalanceType[]
}

let pollingHandle: ReturnType<typeof setInterval> | undefined
let inflightRefresh: Promise<void> | null = null

/**
 * Triggers a balance refresh and updates Jotai atoms with the fetched values.
 * Fetches EVM USDC balance.
 */
export async function refreshBalances(options: BalanceRefreshOptions = {}): Promise<void> {
  if (inflightRefresh) {
    return inflightRefresh
  }

  const store = jotaiStore
  store.set(balanceSyncAtom, (state) => ({
    ...state,
    status: 'refreshing',
  }))

  inflightRefresh = (async () => {
    try {
      // Default to EVM balance type only (Namada removed)
      const balanceTypes = options.balanceTypes ?? ['evm']
      const shouldFetchEvm = balanceTypes.includes('evm')

      // Get wallet state
      const walletState = store.get(walletAtom)
      const metaMaskAddress = walletState.metaMask?.account
      const chainConfig = store.get(chainConfigAtom)

      // Determine chain key: use provided option, or preferred from atom, or derive from chainId, or use default
      let chainKey = options.chainKey
      if (!chainKey) {
        const preferredChainKey = store.get(preferredChainKeyAtom)
        if (preferredChainKey) {
          chainKey = preferredChainKey
        }
      }
      if (!chainKey && walletState.metaMask.chainId && chainConfig) {
        const chain = findChainByChainId(chainConfig, walletState.metaMask.chainId)
        chainKey = chain?.key
      }
      if (!chainKey && chainConfig) {
        chainKey = getDefaultChainKey(chainConfig)
      }

      // Validate chain key exists in config before fetching balance
      const chainExists = chainKey && chainConfig ? findChainByKey(chainConfig, chainKey) !== undefined : false

      // Fetch EVM balance if requested
      let evmBalance: { usdc: string; chainKey?: string } | undefined
      if (shouldFetchEvm) {
        evmBalance = { usdc: '--', chainKey }
        if (walletState.metaMask.isConnected && metaMaskAddress && chainKey && chainExists) {
          try {
            const balance = await fetchEvmUsdcBalance(chainKey, metaMaskAddress)
            evmBalance = { usdc: balance, chainKey }
            // Clear EVM error on success
            store.set(balanceErrorsAtom, (state) => {
              const { evm, ...rest } = state
              return rest
            })
            store.set(balanceSyncAtom, (state) => ({
              ...state,
              evmStatus: 'idle',
            }))
          } catch (error) {
            console.error('[BalanceService] Failed to fetch EVM balance', {
              chainKey,
              error: error instanceof Error ? error.message : String(error),
            })
            evmBalance = { usdc: '--', chainKey }
            const errorMessage = error instanceof Error ? error.message : 'Unknown EVM balance error'
            store.set(balanceErrorsAtom, (state) => ({
              ...state,
              evm: errorMessage,
            }))
            store.set(balanceSyncAtom, (state) => ({
              ...state,
              evmStatus: 'error',
            }))
          }
        } else {
          console.debug('[BalanceService] Skipping EVM balance fetch', {
            isConnected: walletState.metaMask.isConnected,
            hasAddress: !!metaMaskAddress,
            chainKey,
            chainExists,
          })
          // Clear EVM error if we're skipping (not an error condition)
          store.set(balanceErrorsAtom, (state) => {
            const { evm, ...rest } = state
            return rest
          })
          store.set(balanceSyncAtom, (state) => ({
            ...state,
            evmStatus: 'idle',
          }))
        }
      }

      const completedAt = Date.now()

      // Update balance atom with fetched values (preserve existing values for types not fetched)
      store.set(balanceAtom, (state) => ({
        evm: evmBalance
          ? {
              usdc: evmBalance.usdc ?? state.evm.usdc,
              chainKey: evmBalance.chainKey ?? state.evm.chainKey,
              lastUpdated: completedAt,
            }
          : state.evm,
        namada: state.namada,
      }))
      store.set(balanceErrorAtom, undefined)
      store.set(balanceSyncAtom, (state) => ({
        ...state,
        status: 'idle',
        lastSuccessAt: completedAt,
      }))
    } catch (error) {
      console.error('Balance refresh failed', error)
      const message = error instanceof Error ? error.message : 'Unknown balance refresh error'
      store.set(balanceErrorAtom, message)
      store.set(balanceSyncAtom, (state) => ({
        ...state,
        status: 'error',
      }))
    }
  })()

  try {
    await inflightRefresh
  } finally {
    inflightRefresh = null
  }
}

/**
 * Starts polling balances at a fixed interval. Subsequent calls are ignored
 * until `stopBalancePolling` is invoked.
 */
export function startBalancePolling(options: { intervalMs?: number; runImmediate?: boolean } = {}): void {
  if (pollingHandle) {
    return
  }

  const intervalMs = Math.max(options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS, 1_000)

  if (options.runImmediate !== false) {
    void refreshBalances({ trigger: 'init' })
  }

  pollingHandle = setInterval(() => {
    void refreshBalances({ trigger: 'poll' })
  }, intervalMs)
}

export function stopBalancePolling(): void {
  if (!pollingHandle) {
    return
  }

  clearInterval(pollingHandle)
  pollingHandle = undefined
}

export function isBalancePollingActive(): boolean {
  return Boolean(pollingHandle)
}

export function requestBalanceRefresh(options: BalanceRefreshOptions = {}): Promise<void> {
  return refreshBalances({ ...options, trigger: options.trigger ?? 'manual' })
}
