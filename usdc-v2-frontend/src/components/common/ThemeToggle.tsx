import { Moon, Sun } from 'lucide-react'
import { useTheme } from '@/hooks/useTheme'
import { Button } from './Button'

export function ThemeToggle() {
  const { isDark, toggleTheme } = useTheme()

  return (
    <Button
      type="button"
      variant="ghost"
      onClick={toggleTheme}
      className="h-9 w-9 p-0 rounded-full"
      aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
    >
      {isDark ? (
        <Sun className="h-4 w-4" />
      ) : (
        <Moon className="h-4 w-4" />
      )}
    </Button>
  )
}
