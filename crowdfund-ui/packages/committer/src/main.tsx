// ABOUTME: Entry point for the crowdfund committer app.
// ABOUTME: Renders with wagmi, RainbowKit, Jotai, routing, toast providers, and Sentry error boundary.
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { Provider as JotaiProvider } from 'jotai'
import { CrowdfundToaster } from '@armada/crowdfund-shared'
import { WagmiProvider } from 'wagmi'
import { RainbowKitProvider, darkTheme } from '@rainbow-me/rainbowkit'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MotionConfig } from 'framer-motion'
import { wagmiConfig } from '@/config/wagmi'
import { App } from '@/App'
import { InviteLandingPage } from '@/components/InviteLandingPage'
import { initSentry, SentryErrorBoundary } from '@/lib/sentry'
import { validateEnv } from '@/config/validateEnv'
import '@rainbow-me/rainbowkit/styles.css'
import './index.css'

initSentry()

const queryClient = new QueryClient()

const root = createRoot(document.getElementById('root')!)

// Refuse to boot a misconfigured production build. Rendering a styled error
// screen (rather than a blank page or a silently-wrong app) makes the missing
// config obvious to whoever deployed it.
const envCheck = validateEnv(import.meta.env)
if (!envCheck.ok) {
  root.render(
    <StrictMode>
      <div className="min-h-screen bg-background text-foreground flex items-center justify-center p-6">
        <div className="max-w-md space-y-4 text-center">
          <h1 className="text-destructive text-xl font-semibold">Configuration error</h1>
          <p className="text-muted-foreground">
            This deployment is missing required configuration and cannot start safely.
          </p>
          <ul className="space-y-1 text-left text-sm text-muted-foreground">
            {envCheck.errors.map((message) => (
              <li key={message}>• {message}</li>
            ))}
          </ul>
        </div>
      </div>
    </StrictMode>,
  )
} else {
  root.render(
    <StrictMode>
      <SentryErrorBoundary fallback={<div className="p-6">An unexpected error occurred. The team has been notified.</div>}>
        <WagmiProvider config={wagmiConfig}>
          <QueryClientProvider client={queryClient}>
            <RainbowKitProvider theme={darkTheme()}>
              <JotaiProvider>
                <BrowserRouter>
                  <MotionConfig reducedMotion="user">
                    <Routes>
                      <Route path="/" element={<App />} />
                      <Route path="/invite" element={<InviteLandingPage />} />
                    </Routes>
                  </MotionConfig>
                </BrowserRouter>
                <CrowdfundToaster />
              </JotaiProvider>
            </RainbowKitProvider>
          </QueryClientProvider>
        </WagmiProvider>
      </SentryErrorBoundary>
    </StrictMode>,
  )
}
