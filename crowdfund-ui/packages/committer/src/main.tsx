// ABOUTME: Entry point for the crowdfund committer app.
// ABOUTME: Renders with wagmi, RainbowKit, Jotai, routing, toast providers, and Sentry error boundary.
import { StrictMode, Suspense, lazy } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { Provider as JotaiProvider } from 'jotai'
import { CrowdfundToaster } from '@armada/crowdfund-shared'
import { WagmiProvider } from 'wagmi'
import { RainbowKitProvider, darkTheme } from '@rainbow-me/rainbowkit'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MotionConfig } from 'framer-motion'
import { wagmiConfig } from '@/config/wagmi'
import { getMockSizeFromUrl } from '@/appNav'
import { initSentry, SentryErrorBoundary, isSentryEnabled } from '@/lib/sentry'
import { validateEnv } from '@/config/validateEnv'
import '@rainbow-me/rainbowkit/styles.css'
import './index.css'

// Lazy-load the routes so each lands in its own chunk: the /invite landing page
// and the dev-only MockCommitterApp (TreeView/TableView → d3 + react-table) stay
// out of the main bundle.
const App = lazy(() => import('@/App').then((m) => ({ default: m.App })))
const InviteLandingPage = lazy(() =>
  import('@/components/InviteLandingPage').then((m) => ({ default: m.InviteLandingPage })),
)
const MockCommitterApp = lazy(() => import('@/MockCommitterApp'))

initSentry()

// Every data hook already sets its own retry + refetchInterval; these defaults
// make the baseline policy explicit without changing observed behavior:
//  - retry:false — a polling UI self-heals on the next interval, so surface
//    errors immediately rather than retrying behind a spinner.
//  - refetchIntervalInBackground:false — pause background polling in hidden tabs.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchIntervalInBackground: false,
    },
  },
})

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

  // Dev-only stress harness selection (0 in production).
  const mockSize = getMockSizeFromUrl()
  const suspenseFallback = (
    <div className="min-h-screen bg-background text-foreground flex items-center justify-center p-6 text-muted-foreground">
      Loading…
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
                    <Suspense fallback={suspenseFallback}>
                      {mockSize > 0 ? (
                        <MockCommitterApp size={mockSize} />
                      ) : (
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
                      )}
                    </Suspense>
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
