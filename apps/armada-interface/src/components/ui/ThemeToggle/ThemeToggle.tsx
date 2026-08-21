// ABOUTME: Header control that switches between light and dark themes; persists the choice to localStorage.
// ABOUTME: Wired to `useTheme`; renders a frosted IconButton showing the target theme's glyph (moon in light, sun in dark).

import { MoonIcon, SunIcon } from '@heroicons/react/24/outline'
import { IconButton } from '@/design'
import { useTheme } from '@/hooks/useTheme'
import styles from './ThemeToggle.module.css'

/** Switch light / dark. Persists to localStorage (`armada-theme`). */
export function ThemeToggle() {
  const [theme, , toggleTheme] = useTheme()
  const isDark = theme === 'dark'

  return (
    <IconButton
      variant="frosted"
      size="sm"
      className={styles.button}
      iconClassName={styles.glyph}
      icon={isDark ? <SunIcon strokeWidth={1.5} /> : <MoonIcon strokeWidth={1.5} />}
      aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
      onClick={toggleTheme}
    />
  )
}
