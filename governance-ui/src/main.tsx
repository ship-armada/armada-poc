// ABOUTME: Entry point for the governance test UI React app.
// ABOUTME: Mounts the App component into the DOM root element.

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
