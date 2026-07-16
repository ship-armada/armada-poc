// ABOUTME: useDebouncedValue — returns a trailing-debounced copy of a value that only updates after
// ABOUTME: the input has stopped changing for `delayMs`. Used to throttle per-keystroke on-chain reads.

import { useEffect, useState } from 'react'

/**
 * Trailing debounce: returns `value` but only after it has been stable for `delayMs`. Each change
 * resets the timer. Useful for gating an expensive effect (an `eth_call`, a network fetch) on a
 * fast-changing input (a text field) without firing once per keystroke.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(timer)
  }, [value, delayMs])
  return debounced
}
