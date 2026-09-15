// ABOUTME: Crowdfund left column — shell max-height open; filter in middle; sequenced close.
// ABOUTME: Ported from armada-crowdfund; owns listContentVisible timing so Show address does not glitch.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { SHORT_VIEWPORT_MAX_HEIGHT_PX } from '../../lib/viewportBreakpoints.js'
import {
  CROWDFUND_LIST_CONTENT_FADE_MS,
  CROWDFUND_LIST_EXPAND_MS,
} from './crowdfundLeftColumnTiming.js'
import styles from './CrowdfundLeftColumn.module.css'

export interface CrowdfundListAnimationContextValue {
  listOpen: boolean
  listContentVisible: boolean
  requestOpen: () => void
  requestClose: () => void
}

const CrowdfundListAnimationContext = createContext<CrowdfundListAnimationContextValue | null>(
  null,
)

export function useCrowdfundListAnimation(): CrowdfundListAnimationContextValue {
  const ctx = useContext(CrowdfundListAnimationContext)
  if (!ctx) {
    throw new Error('useCrowdfundListAnimation must be used within CrowdfundLeftColumn')
  }
  return ctx
}

export interface CrowdfundLeftColumnProps {
  progress: ReactNode
  list: ReactNode
  controls: ReactNode
  listOpen: boolean
  onListOpenChange: (open: boolean) => void
  className?: string
}

export function CrowdfundLeftColumn({
  progress,
  list,
  controls,
  listOpen,
  onListOpenChange,
  className,
}: CrowdfundLeftColumnProps) {
  const shellRef = useRef<HTMLDivElement | null>(null)
  const [listContentVisible, setListContentVisible] = useState(false)
  const [listLayoutClosing, setListLayoutClosing] = useState(false)
  const [isShortViewport, setIsShortViewport] = useState(false)
  const [shortListExpanded, setShortListExpanded] = useState(false)
  const [shortCardPhase, setShortCardPhase] = useState<'exit' | 'enter' | null>(null)
  const [shortCardAnimActive, setShortCardAnimActive] = useState(false)
  const timersRef = useRef<number[]>([])
  const shortCardRafRef = useRef(0)

  const shellListExpanded = listOpen && (!isShortViewport || shortListExpanded)

  const clearTimers = useCallback(() => {
    timersRef.current.forEach((id) => window.clearTimeout(id))
    timersRef.current = []
    cancelAnimationFrame(shortCardRafRef.current)
  }, [])

  const runShortCardAnim = useCallback((phase: 'exit' | 'enter') => {
    setShortCardPhase(phase)
    setShortCardAnimActive(false)
    cancelAnimationFrame(shortCardRafRef.current)
    shortCardRafRef.current = requestAnimationFrame(() => {
      shortCardRafRef.current = requestAnimationFrame(() => setShortCardAnimActive(true))
    })
  }, [])

  const requestOpen = useCallback(() => {
    clearTimers()
    setListLayoutClosing(false)
    onListOpenChange(true)

    // LOCKED short open: card down+fade → shell expand → list fade (see crowdfundLeftColumnTiming.ts)
    if (window.matchMedia(`(max-height: ${SHORT_VIEWPORT_MAX_HEIGHT_PX}px)`).matches) {
      setShortListExpanded(false)
      runShortCardAnim('exit')
      const expandListId = window.setTimeout(() => {
        setShortCardPhase(null)
        setShortCardAnimActive(false)
        setShortListExpanded(true)
      }, CROWDFUND_LIST_EXPAND_MS)
      const showContentId = window.setTimeout(() => {
        setListContentVisible(true)
      }, CROWDFUND_LIST_EXPAND_MS + CROWDFUND_LIST_EXPAND_MS)
      timersRef.current.push(expandListId, showContentId)
      return
    }

    const id = window.setTimeout(() => {
      setListContentVisible(true)
    }, CROWDFUND_LIST_EXPAND_MS)
    timersRef.current.push(id)
  }, [clearTimers, onListOpenChange, runShortCardAnim])

  const requestClose = useCallback(() => {
    clearTimers()
    setListContentVisible(false)

    // LOCKED short close: list fade → retract (filter fixed) → card up+fade; do not reorder timers
    if (window.matchMedia(`(max-height: ${SHORT_VIEWPORT_MAX_HEIGHT_PX}px)`).matches) {
      const startCollapseId = window.setTimeout(() => {
        setListLayoutClosing(true)
      }, CROWDFUND_LIST_CONTENT_FADE_MS)
      const showCardId = window.setTimeout(() => {
        setListLayoutClosing(false)
        runShortCardAnim('enter')
      }, CROWDFUND_LIST_CONTENT_FADE_MS + CROWDFUND_LIST_EXPAND_MS)
      const finishId = window.setTimeout(() => {
        onListOpenChange(false)
        setShortListExpanded(false)
        setShortCardPhase(null)
        setShortCardAnimActive(false)
      }, CROWDFUND_LIST_CONTENT_FADE_MS + CROWDFUND_LIST_EXPAND_MS + CROWDFUND_LIST_EXPAND_MS)
      timersRef.current.push(startCollapseId, showCardId, finishId)
      return
    }

    const collapseId = window.setTimeout(() => {
      setListLayoutClosing(true)
    }, CROWDFUND_LIST_EXPAND_MS)
    const finishId = window.setTimeout(() => {
      onListOpenChange(false)
      setListLayoutClosing(false)
    }, CROWDFUND_LIST_EXPAND_MS + CROWDFUND_LIST_EXPAND_MS)
    timersRef.current.push(collapseId, finishId)
  }, [clearTimers, onListOpenChange, runShortCardAnim])

  useEffect(() => clearTimers, [clearTimers])

  useEffect(() => {
    const mq = window.matchMedia(`(max-height: ${SHORT_VIEWPORT_MAX_HEIGHT_PX}px)`)
    const sync = () => setIsShortViewport(mq.matches)
    sync()
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [])

  useEffect(() => {
    if (!listOpen) {
      setListContentVisible(false)
      setListLayoutClosing(false)
      setShortListExpanded(false)
      setShortCardPhase(null)
      setShortCardAnimActive(false)
    }
  }, [listOpen])

  useLayoutEffect(() => {
    const shell = shellRef.current
    if (!shell || listOpen) return

    const measure = () => {
      const h = Math.ceil(shell.getBoundingClientRect().height)
      if (h < 1) return false
      const px = `${h}px`
      shell.style.setProperty('--hero-stack-collapsed-height', px)
      shell
        .closest<HTMLElement>('[class*="leftCorner"]')
        ?.style.setProperty('--hero-stack-collapsed-height', px)
      return true
    }

    if (measure()) return
    const raf = requestAnimationFrame(() => {
      if (!measure()) requestAnimationFrame(measure)
    })
    return () => cancelAnimationFrame(raf)
  }, [listOpen])

  const animationValue: CrowdfundListAnimationContextValue = {
    listOpen,
    listContentVisible,
    requestOpen,
    requestClose,
  }

  const shellClass = [
    styles.shell,
    shellListExpanded && styles.shellOpen,
    listLayoutClosing && styles.shellLayoutClosing,
    shortCardPhase === 'exit' && styles.shellShortCardExiting,
    shortCardPhase === 'exit' && shortCardAnimActive && styles.shellShortCardExitingActive,
    shortCardPhase === 'enter' && styles.shellShortCardEntering,
    shortCardPhase === 'enter' && shortCardAnimActive && styles.shellShortCardEnteringActive,
    isShortViewport &&
      shortListExpanded &&
      listOpen &&
      shortCardPhase !== 'enter' &&
      styles.shellShortCardDone,
    className,
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <CrowdfundListAnimationContext.Provider value={animationValue}>
      <div className={styles.column}>
        <div ref={shellRef} className={shellClass}>
          <div className={styles.progressSlot} data-crowdfund-progress>
            {progress}
          </div>
          <div className={styles.middle}>
            <div className={styles.listRegion}>{list}</div>
            <div className={styles.controlsSlot}>{controls}</div>
          </div>
        </div>
      </div>
    </CrowdfundListAnimationContext.Provider>
  )
}
