// ABOUTME: Theme persistence + application helpers — reads/writes the `data-theme` attribute on <html> and localStorage.
// ABOUTME: Ported from the armada-crowdfund mockup; consumed by WalletPillMenu's light/dark toggle.

export const THEME_STORAGE_KEY = 'armada-theme'

export type Theme = 'light' | 'dark'

export function isTheme(value: string | null): value is Theme {
  return value === 'light' || value === 'dark'
}

/** Theme from localStorage, or null when the user has not chosen yet. */
export function getSavedTheme(): Theme | null {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY)
    return isTheme(saved) ? saved : null
  } catch {
    return null
  }
}

export function getSystemTheme(): Theme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

/** Current applied theme on <html data-theme>. */
export function getAppliedTheme(): Theme {
  const attr = document.documentElement.getAttribute('data-theme')
  return attr === 'light' ? 'light' : 'dark'
}

/** Apply theme to the document and persist an explicit user choice. */
export function setTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme)
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme)
  } catch {
    // ignore quota / private mode
  }
}
