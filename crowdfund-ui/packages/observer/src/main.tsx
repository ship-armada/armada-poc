// ABOUTME: Entry point for the crowdfund observer app.
// ABOUTME: Renders the React app with Jotai provider and toast container.
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Provider as JotaiProvider } from 'jotai'
import { CrowdfundToaster } from '@armada/crowdfund-shared'
import { App } from '@/App'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <JotaiProvider>
      <App />
      <CrowdfundToaster />
    </JotaiProvider>
  </StrictMode>,
)
