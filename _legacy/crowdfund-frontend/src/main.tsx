// ABOUTME: Entry point for the crowdfund testing frontend.
// ABOUTME: Renders the React app with Jotai provider and toast container.
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Provider as JotaiProvider } from 'jotai'
import { Toaster } from 'sonner'
import { jotaiStore } from '@/store/jotaiStore'
import { App } from '@/App'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <JotaiProvider store={jotaiStore}>
      <App />
      <Toaster richColors position="bottom-right" />
    </JotaiProvider>
  </StrictMode>,
)
