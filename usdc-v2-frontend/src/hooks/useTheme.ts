import { useState, useEffect, useCallback } from 'react'

const THEME_STORAGE_KEY = 'theme'
const DEFAULT_THEME = 'dark' as const

export function useTheme() {
  const [isDark, setIsDark] = useState<boolean>(() => {
    // Initialize from localStorage if available, otherwise default to dark
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem(THEME_STORAGE_KEY)
      if (stored === 'dark' || stored === 'light') {
        return stored === 'dark'
      }
    }
    return DEFAULT_THEME === 'dark'
  })

  // Apply theme class to HTML element and save to localStorage
  useEffect(() => {
    if (typeof window === 'undefined') return

    const htmlElement = document.documentElement
    
    // Apply or remove dark class
    if (isDark) {
      htmlElement.classList.add('dark')
    } else {
      htmlElement.classList.remove('dark')
    }

    // Save to localStorage
    localStorage.setItem(THEME_STORAGE_KEY, isDark ? 'dark' : 'light')
  }, [isDark])

  // Read from localStorage on mount (in case it was set before React initialized)
  useEffect(() => {
    if (typeof window === 'undefined') return

    const stored = localStorage.getItem(THEME_STORAGE_KEY)
    if (stored === 'dark' || stored === 'light') {
      setIsDark(stored === 'dark')
    } else {
      // If no stored preference, set default
      setIsDark(DEFAULT_THEME === 'dark')
    }
  }, [])

  const toggleTheme = useCallback(() => {
    setIsDark((prev) => !prev)
  }, [])

  return {
    isDark,
    toggleTheme,
  }
}
