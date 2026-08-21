// ABOUTME: React hook over the `data-theme` attribute — subscribes to `theme-change` + cross-tab `storage` events.
// ABOUTME: Returns `[theme, applyTheme, toggleTheme]`; backed by `useSyncExternalStore` so the UI tracks the applied theme.

import { useCallback, useSyncExternalStore } from 'react'
import {
  THEME_STORAGE_KEY,
  getAppliedTheme,
  setTheme,
  type Theme,
} from '@/design/utils/theme'

function subscribeToTheme(onStoreChange: () => void) {
  const onThemeChange = () => onStoreChange()
  const onStorage = (event: StorageEvent) => {
    if (event.key === THEME_STORAGE_KEY) onStoreChange()
  }

  window.addEventListener('theme-change', onThemeChange)
  window.addEventListener('storage', onStorage)
  return () => {
    window.removeEventListener('theme-change', onThemeChange)
    window.removeEventListener('storage', onStorage)
  }
}

export function useTheme() {
  const theme = useSyncExternalStore(subscribeToTheme, getAppliedTheme, () => 'light' as Theme)
  const applyTheme = useCallback((next: Theme) => setTheme(next), [])
  const toggleTheme = useCallback(() => {
    setTheme(getAppliedTheme() === 'dark' ? 'light' : 'dark')
  }, [])
  return [theme, applyTheme, toggleTheme] as const
}
