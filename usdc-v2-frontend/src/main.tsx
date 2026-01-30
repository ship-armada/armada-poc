import './index.css'

// Initialize theme synchronously before React renders to prevent flash
const THEME_STORAGE_KEY = 'theme'
const DEFAULT_THEME = 'dark'
const storedTheme = localStorage.getItem(THEME_STORAGE_KEY)
const isDark = storedTheme === 'dark' || storedTheme === 'light' 
  ? storedTheme === 'dark' 
  : DEFAULT_THEME === 'dark'

if (isDark) {
  document.documentElement.classList.add('dark')
} else {
  document.documentElement.classList.remove('dark')
}

import { createRoot } from 'react-dom/client'
import { AppMain } from './app/main'

const container = document.getElementById('root')

if (!container) {
  throw new Error('Root element with id "root" was not found in the document.')
}

createRoot(container).render(<AppMain />)
