import type { EvmChainsFile } from '@/config/chains'
import { fetchEvmChainsConfig } from '@/services/config/chainConfigService'
import { startBalancePolling } from '@/services/balance/balanceService'
import { attemptMetaMaskReconnection } from '@/services/wallet/walletService'
import { loadCustomChainUrls } from '@/services/storage/customChainUrlsStorage'
import { jotaiStore } from '@/store/jotaiStore'
import { customEvmChainUrlsAtom } from '@/atoms/customChainUrlsAtom'

export interface BootstrapResult {
  chains: EvmChainsFile
}

export async function initializeApplication(): Promise<BootstrapResult> {
  // Load custom chain URLs from localStorage before loading chain configs
  const storedUrls = loadCustomChainUrls()
  if (storedUrls) {
    if (storedUrls.evm && Object.keys(storedUrls.evm).length > 0) {
      jotaiStore.set(customEvmChainUrlsAtom, storedUrls.evm)
    }
  }

  const chains = await fetchEvmChainsConfig()

  // Start periodic balance refresh loop
  startBalancePolling({ intervalMs: 10_000, runImmediate: true })

  // Attempt to reconnect to MetaMask if already connected (non-interactive)
  await attemptMetaMaskReconnection()

  return { chains }
}
