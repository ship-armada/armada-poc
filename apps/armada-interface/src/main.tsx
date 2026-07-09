// ABOUTME: Mount + provider tree for @armada/interface — Wagmi → Query → RainbowKit → Router.
// ABOUTME: Jotai intentionally has no Provider so React hooks share `getDefaultStore()` with the module-scope tx executor.

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { WagmiProvider } from 'wagmi'
import { RainbowKitProvider, darkTheme } from '@rainbow-me/rainbowkit'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'sonner'

import { wagmiConfig } from '@/config/wagmi'
import { installBisectingGetLogs } from '@/lib/rpc-bisecting'
import { AppErrorBoundary } from '@/components/AppErrorBoundary'
import { initSentry } from '@/lib/sentry'
import { trackError } from '@/lib/telemetry'
import { App } from '@/App'

// Initialise Sentry first so it can capture errors thrown during the rest of bootstrap. No-op
// unless VITE_SENTRY_DSN is set (local/dev + un-configured builds transmit nothing). The app's
// existing AppErrorBoundary + global rejection handler + lib/telemetry's trackError all funnel
// into Sentry via this — no separate <SentryErrorBoundary> wrapper needed.
initSentry()

// Install at the earliest possible point — before any provider is constructed. Patches
// ethers' JsonRpcProvider.prototype.send to bisect eth_getLogs on "block range too large"
// errors, so free-tier RPCs (Alchemy 10 blocks, Infura quotas, etc.) Just Work with the
// Railgun engine's 499-block scan chunks. Idempotent + prototype-level, so all ethers
// providers in the process (including the SDK's internal PollingJsonRpcProvider) pick it up.
installBisectingGetLogs()
import { Dashboard } from '@/pages/Dashboard'
import { History } from '@/pages/History'
import { Settings } from '@/pages/Settings'
import { AddressBook } from '@/pages/AddressBook'
import { Debug } from '@/pages/Debug'

import '@rainbow-me/rainbowkit/styles.css'
import './index.css'

const queryClient = new QueryClient()

// Last-resort handler for promise rejections that escape their call site (a `void`-ed async path,
// a missing .catch). Routes them to telemetry so they're visible instead of only a console warning.
if (typeof window !== 'undefined') {
  window.addEventListener('unhandledrejection', (event) => {
    trackError('unhandled', event.reason)
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* Error boundary OUTSIDE the providers (it needs none of them) but inside StrictMode, so a
        render error anywhere in the app surfaces a recoverable card instead of a white screen. */}
    <AppErrorBoundary>
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider
          theme={darkTheme({
            // Brand tokens lifted from @armada/ui:
            //   accent      = --primitives-color-purple-500 (brand-lavender)
            //   foreground  = --primitives-color-purple-900 (brand-deep) — high-contrast on lavender
            // Hex literals (not CSS vars) because RainbowKit's theme builder feeds these
            // straight to its inline style props, not to a stylesheet.
            accentColor: '#c491e5',
            accentColorForeground: '#291433',
            // RainbowKit borderRadius is a 4-value enum: 'none' | 'small' | 'medium' | 'large'.
            // 'large' (~16px) is the closest match to our Card radius (8px) without going harsh.
            borderRadius: 'large',
            overlayBlur: 'small',
          })}
        >
          {/* No <Provider> from jotai — without one, useAtomValue/useSetAtom fall back to
              getDefaultStore(), which is the SAME store the module-scope tx executor reads.
              Wrapping with <Provider> here would create an isolated store and cause submit()
              writes to be invisible to the executor. Tests still wrap with Provider+createStore
              for isolation (overriding the default store via context). */}
          <BrowserRouter>
            <Routes>
              <Route element={<App />}>
                <Route index element={<Dashboard />} />
                <Route path="history" element={<History />} />
                <Route path="settings" element={<Settings />} />
                <Route path="address-book" element={<AddressBook />} />
                {/* Debug page is available in both modes — contract addresses + per-chain
                    balances are useful diagnostics regardless. The local-only faucet UI is
                    gated inside the page itself. */}
                <Route path="debug" element={<Debug />} />
              </Route>
            </Routes>
            <Toaster theme="dark" position="bottom-right" />
          </BrowserRouter>
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
    </AppErrorBoundary>
  </StrictMode>,
)
