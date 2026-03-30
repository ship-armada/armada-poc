// ABOUTME: Entry point for the crowdfund committer app.
// ABOUTME: Renders the React app with routing, Jotai provider, and toast container.
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { Provider as JotaiProvider } from 'jotai'
import { Toaster } from 'sonner'
import { App } from '@/App'
import { InviteLinkRedemption } from '@/components/InviteLinkRedemption'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <JotaiProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<App />} />
          <Route path="/invite" element={<InviteLinkRedemption />} />
        </Routes>
      </BrowserRouter>
      <Toaster richColors position="bottom-right" />
    </JotaiProvider>
  </StrictMode>,
)
