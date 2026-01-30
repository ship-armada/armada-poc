import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { WagmiProvider } from 'wagmi'
import { wagmiConfig } from './config/wagmi'
import { ShieldedWalletProvider } from './hooks/useShieldedWallet'
import './index.css'
import App from './App'

// Debug utilities - expose to window for console access
import { getRailgunContractState } from './lib/sdk'
if (typeof window !== 'undefined') {
  (window as any).railgunDebug = {
    getRailgunContractState,
  }
}

const queryClient = new QueryClient()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <ShieldedWalletProvider>
          <App />
        </ShieldedWalletProvider>
      </QueryClientProvider>
    </WagmiProvider>
  </StrictMode>,
)
