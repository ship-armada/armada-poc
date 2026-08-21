// ABOUTME: Theme persistence + application helpers — reads/writes the `data-theme` attribute on <html> and localStorage.
// ABOUTME: Consumed by the `useTheme` hook and the header `ThemeToggle`; emits a `theme-change` event so subscribers update.

export const THEME_STORAGE_KEY = 'armada-theme'

/** Keep in sync with `--semantic-motion-theme` in theme-overrides.css. */
export const THEME_TRANSITION_MS = 320

export type Theme = 'light' | 'dark'

/** Default when the user has not chosen. */
export const DEFAULT_THEME: Theme = 'light'

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
  return attr === 'dark' ? 'dark' : 'light'
}

/**
 * Apply theme to the document and persist an explicit user choice.
 *
 * Animates the color crossfade by setting a transient `data-theme-transition`
 * attribute (matched by a global CSS rule) before flipping `data-theme`, then
 * removing it once the transition window elapses. The animation is skipped under
 * `prefers-reduced-motion`, when there is no prior theme to transition from, or
 * when `options.animate` is `false`. Dispatches a `theme-change` event afterwards
 * so `useSyncExternalStore` subscribers re-read.
 */
export function setTheme(theme: Theme, options?: { animate?: boolean }): void {
  const root = document.documentElement
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const current = root.getAttribute('data-theme')
  const shouldAnimate =
    (options?.animate ?? true) && !reducedMotion && current !== null && current !== theme

  if (shouldAnimate) {
    root.setAttribute('data-theme-transition', '')
    // Flush so `transition` is registered before colors change (otherwise a snap).
    void root.offsetWidth
  }

  root.setAttribute('data-theme', theme)
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme)
  } catch {
    // ignore quota / private mode
  }
  window.dispatchEvent(new CustomEvent('theme-change'))

  if (shouldAnimate) {
    window.setTimeout(() => {
      root.removeAttribute('data-theme-transition')
    }, THEME_TRANSITION_MS)
  }
}
