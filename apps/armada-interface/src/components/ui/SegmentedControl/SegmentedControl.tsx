// ABOUTME: SegmentedControl — pill track with a sliding indicator + roving-tabindex arrow-key nav.
// ABOUTME: `equal` (fill) or `scroll` (overflowing, edge-faded) layout; `frost` or `raised` surface; `sm`/`md` sizes.

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from 'react'
import styles from './SegmentedControl.module.css'

export type SegmentedControlSize = 'sm' | 'md'
export type SegmentedControlLayout = 'equal' | 'scroll'
export type SegmentedControlSurface = 'frost' | 'raised'

export interface SegmentedControlOption<T extends string = string> {
  id: T
  label: string
}

export interface SegmentedControlProps<T extends string = string> {
  options: ReadonlyArray<SegmentedControlOption<T>>
  value: T
  onChange: (id: T) => void
  size?: SegmentedControlSize
  /** `equal` fills the track in equal columns; `scroll` is a horizontally-scrollable track for overflow. */
  layout?: SegmentedControlLayout
  /** `frost` on the dashboard wash; `raised` gray on opaque panels. */
  surface?: SegmentedControlSurface
  'aria-label': string
  className?: string
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  size = 'md',
  layout = 'equal',
  surface = 'frost',
  'aria-label': ariaLabel,
  className,
}: SegmentedControlProps<T>) {
  const listRef = useRef<HTMLDivElement>(null)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const rowRef = useRef<HTMLDivElement>(null)
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])
  const [scrollIndicator, setScrollIndicator] = useState({ left: 0, width: 0 })
  const [scrollFade, setScrollFade] = useState({ start: false, end: false })
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.id === value),
  )
  const count = Math.max(options.length, 1)
  const isScroll = layout === 'scroll'

  // In scroll layout the indicator tracks the selected tab's measured offset/width
  // (columns are content-sized, not equal), and the edge fade masks reflect scroll position.
  useLayoutEffect(() => {
    if (!isScroll) return

    function syncIndicator() {
      const tab = tabRefs.current[selectedIndex]
      if (!tab) return
      setScrollIndicator({ left: tab.offsetLeft, width: tab.offsetWidth })
    }

    function syncFade() {
      const scroller = scrollerRef.current
      if (!scroller) return
      const maxScroll = scroller.scrollWidth - scroller.clientWidth
      setScrollFade({
        start: scroller.scrollLeft > 1,
        end: maxScroll - scroller.scrollLeft > 1,
      })
    }

    syncIndicator()
    syncFade()

    const row = rowRef.current
    const scroller = scrollerRef.current
    if (!row || !scroller || typeof ResizeObserver === 'undefined') return undefined

    const observer = new ResizeObserver(() => {
      syncIndicator()
      syncFade()
    })
    observer.observe(row)
    observer.observe(scroller)
    scroller.addEventListener('scroll', syncFade, { passive: true })
    return () => {
      observer.disconnect()
      scroller.removeEventListener('scroll', syncFade)
    }
  }, [isScroll, options, selectedIndex, size])

  useEffect(() => {
    const list = listRef.current
    const active = tabRefs.current[selectedIndex]
    if (!list || !active) return
    if (list.contains(document.activeElement)) {
      active.focus()
      if (isScroll) {
        active.scrollIntoView({ inline: 'nearest', block: 'nearest' })
      }
    }
  }, [isScroll, selectedIndex])

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
    surface === 'raised' ? styles.trackRaised : styles.trackFrost,
    isScroll ? styles.trackScroll : size === 'sm' ? styles.trackSm : styles.trackMd,
    className,
  ]
    .filter(Boolean)
    .join(' ')

  const tabs = options.map((option, index) => {
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
        className={[
          styles.tab,
          size === 'sm' ? styles.tabSm : styles.tabMd,
          isScroll && styles.tabScroll,
        ]
          .filter(Boolean)
          .join(' ')}
        onClick={() => onChange(option.id)}
      >
        {option.label}
      </button>
    )
  })

  return (
    <div
      ref={listRef}
      className={trackClassName}
      role="tablist"
      aria-label={ariaLabel}
      onKeyDown={handleKeyDown}
      style={{ '--segment-count': count } as CSSProperties}
    >
      {isScroll ? (
        <div
          ref={scrollerRef}
          className={[
            styles.scroller,
            scrollFade.start && scrollFade.end && styles.scrollerFadeBoth,
            scrollFade.start && !scrollFade.end && styles.scrollerFadeStart,
            !scrollFade.start && scrollFade.end && styles.scrollerFadeEnd,
          ]
            .filter(Boolean)
            .join(' ')}
        >
          <div ref={rowRef} className={styles.scrollRow}>
            <span
              className={[styles.indicator, styles.indicatorScroll].join(' ')}
              style={{
                transform: `translateX(${scrollIndicator.left}px)`,
                width: scrollIndicator.width,
              }}
              aria-hidden
            />
            {tabs}
          </div>
        </div>
      ) : (
        <>
          <span
            className={styles.indicator}
            style={{ transform: `translateX(${selectedIndex * 100}%)` }}
            aria-hidden
          />
          {tabs}
        </>
      )}
    </div>
  )
}
