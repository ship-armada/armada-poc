// ABOUTME: SegmentedControl — pill track with a sliding indicator + roving-tabindex arrow-key nav.
// ABOUTME: Ported from the mockup; used for the Earn Add/Withdraw mode tabs. `sm` and `md` sizes.

import { useEffect, useRef, type CSSProperties, type KeyboardEvent } from 'react'
import styles from './SegmentedControl.module.css'

export type SegmentedControlSize = 'sm' | 'md'

export interface SegmentedControlOption<T extends string = string> {
  id: T
  label: string
}

export interface SegmentedControlProps<T extends string = string> {
  options: ReadonlyArray<SegmentedControlOption<T>>
  value: T
  onChange: (id: T) => void
  size?: SegmentedControlSize
  'aria-label': string
  className?: string
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  size = 'md',
  'aria-label': ariaLabel,
  className,
}: SegmentedControlProps<T>) {
  const listRef = useRef<HTMLDivElement>(null)
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.id === value),
  )
  const count = Math.max(options.length, 1)

  useEffect(() => {
    const list = listRef.current
    const active = tabRefs.current[selectedIndex]
    if (!list || !active) return
    if (list.contains(document.activeElement)) {
      active.focus()
    }
  }, [selectedIndex])

  function selectIndex(index: number) {
    const option = options[index]
    if (!option) return
    onChange(option.id)
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (options.length === 0) return

    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      event.preventDefault()
      selectIndex((selectedIndex + 1) % options.length)
      return
    }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault()
      selectIndex((selectedIndex - 1 + options.length) % options.length)
      return
    }
    if (event.key === 'Home') {
      event.preventDefault()
      selectIndex(0)
      return
    }
    if (event.key === 'End') {
      event.preventDefault()
      selectIndex(options.length - 1)
    }
  }

  const trackClassName = [
    styles.track,
    size === 'sm' ? styles.trackSm : styles.trackMd,
    className,
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div
      ref={listRef}
      className={trackClassName}
      role="tablist"
      aria-label={ariaLabel}
      onKeyDown={handleKeyDown}
      style={{ '--segment-count': count } as CSSProperties}
    >
      <span
        className={styles.indicator}
        style={{ transform: `translateX(${selectedIndex * 100}%)` }}
        aria-hidden
      />
      {options.map((option, index) => {
        const selected = option.id === value

        return (
          <button
            key={option.id}
            ref={(node) => {
              tabRefs.current[index] = node
            }}
            type="button"
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            className={[styles.tab, size === 'sm' ? styles.tabSm : styles.tabMd].join(' ')}
            onClick={() => onChange(option.id)}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
