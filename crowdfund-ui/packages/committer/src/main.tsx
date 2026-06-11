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
import { initSentry, SentryErrorBoundary, isSentryEnabled } from '@/lib/sentry'
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
  // Only claim the team was notified if Sentry is actually wired up.
  const notified = isSentryEnabled() ? ' The team has been notified.' : ' Please refresh the page.'
  const rootFallback = <div className="p-6">An unexpected error occurred.{notified}</div>

  // The /invite landing page is the highest-stakes entry point and has no close
  // button — give it its own boundary with an escape hatch back to the app so a
  // landing-page crash doesn't drop the user into the bare root fallback.
  const inviteFallback = (
    <div className="min-h-screen bg-background text-foreground flex items-center justify-center p-6">
      <div className="max-w-md space-y-4 text-center">
        <h1 className="text-destructive text-xl font-semibold">Something went wrong</h1>
        <p className="text-muted-foreground">
          This invite link couldn't be loaded.{isSentryEnabled() ? ' The team has been notified.' : ''}
        </p>
        <a href="/" className="text-primary underline">Go to the crowdfund</a>
      </div>
    </div>
  )

  root.render(
    <StrictMode>
      <SentryErrorBoundary fallback={rootFallback}>
        <WagmiProvider config={wagmiConfig}>
          <QueryClientProvider client={queryClient}>
            <RainbowKitProvider theme={darkTheme()}>
              <JotaiProvider>
                <BrowserRouter>
                  <MotionConfig reducedMotion="user">
                    <Routes>
                      <Route path="/" element={<App />} />
                      <Route
                        path="/invite"
                        element={
                          <SentryErrorBoundary fallback={inviteFallback}>
                            <InviteLandingPage />
                          </SentryErrorBoundary>
                        }
                      />
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
