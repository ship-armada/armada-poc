// ABOUTME: Debounced search input for filtering tree and table views.
// ABOUTME: Shared between all views that need address/ENS search.

import { useState, useEffect, useRef, useCallback } from 'react'

export interface SearchBarProps {
  value: string
  onChange: (query: string) => void
  placeholder?: string
  debounceMs?: number
  /** Forwarded to the outer wrapper — useful for inline sizing
   *  (e.g. `flex-1 min-w-[200px]` when the search shares a row with filters). */
  className?: string
}

/**
 * Debounced search input component.
 * Calls onChange after debounceMs of inactivity (default 300ms).
 */
export function SearchBar(props: SearchBarProps) {
  const {
    value,
    onChange,
    placeholder = 'Search address or ENS...',
    debounceMs = 300,
    className,
  } = props
  const [localValue, setLocalValue] = useState(value)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Sync external value changes
  useEffect(() => {
    setLocalValue(value)
  }, [value])

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const newValue = e.target.value
      setLocalValue(newValue)

      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => {
        onChange(newValue)
      }, debounceMs)
    },
    [onChange, debounceMs],
  )

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  return (
    <div className={`relative${className ? ` ${className}` : ''}`}>
      <svg
        className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground"
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="11" cy="11" r="8" />
        <path d="m21 21-4.3-4.3" />
      </svg>
      <input
        type="text"
        value={localValue}
        onChange={handleChange}
        placeholder={placeholder}
        className={
          // Soft translucent fill over the card surface, bigger radius,
          // and a primary-tinted focus ring + border for a more polished
          // anchor element. Primary substitutes for ChatGPT's literal cyan.
          'w-full rounded-lg border border-border/60 bg-background/60 py-2 pl-10 pr-3 text-xs ' +
          'placeholder:text-muted-foreground transition-colors ' +
          'focus:outline-none focus:border-primary/60 focus:ring-2 focus:ring-primary/30'
        }
      />
    </div>
  )
}
