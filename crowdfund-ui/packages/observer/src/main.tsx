// ABOUTME: Entry point for the crowdfund observer app.
// ABOUTME: Renders the React app with react-query, Jotai, and toast container.
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Provider as JotaiProvider } from 'jotai'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MotionConfig } from 'framer-motion'
import { CrowdfundToaster } from '@armada/crowdfund-shared'
import { App } from '@/App'
import './index.css'

const queryClient = new QueryClient()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <JotaiProvider>
        <MotionConfig reducedMotion="user">
          <App />
        </MotionConfig>
        <CrowdfundToaster />
      </JotaiProvider>
    </QueryClientProvider>
  </StrictMode>,
)
