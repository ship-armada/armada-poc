// ABOUTME: Entry point for the crowdfund admin app.
// ABOUTME: Renders the React app with Jotai provider and toast container.
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Provider as JotaiProvider } from 'jotai'
import { Toaster } from 'sonner'
import { MotionConfig } from 'framer-motion'
import { App } from '@/App'
import { initSentry, SentryErrorBoundary } from '@/lib/sentry'
import './index.css'

initSentry()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SentryErrorBoundary fallback={<div className="p-6">An unexpected error occurred. The team has been notified.</div>}>
      <JotaiProvider>
        <MotionConfig reducedMotion="user">
          <App />
        </MotionConfig>
        <Toaster richColors position="bottom-right" />
      </JotaiProvider>
    </SentryErrorBoundary>
  </StrictMode>,
)
