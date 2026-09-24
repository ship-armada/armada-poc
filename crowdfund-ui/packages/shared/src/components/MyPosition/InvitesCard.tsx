// ABOUTME: My Position whitelist panel — hop available rows + expandable invite list.

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react'
import { createPortal } from 'react-dom'
import {
  ChevronDownIcon,
  ChevronUpIcon,
  EllipsisHorizontalIcon,
} from '@heroicons/react/24/outline'
import { Button } from '@armada/ui'
import {
  CROWDFUND_LIST_CONTENT_FADE_MS,
  CROWDFUND_LIST_EXPAND_MS,
} from '../CrowdfundLeftColumn'
import { hopPillDotColor } from '../../lib/graphHopColors'
import { SHORT_VIEWPORT_MAX_HEIGHT_PX } from '../../lib/viewportBreakpoints'
import { truncateAddress, type SlotData } from '../InviteFlow/screens/SlotCard'
import {
  INVITE_COUNT_ROLL_DELAY_MS,
  INVITE_COUNT_ROLL_MS,
  InviteHopFocusChrome,
  useInviteHopFocus,
} from '../InviteFlow/useInviteSlotFocus'
import {
  ALL_INVITE_STATUSES,
  availableForHop,
  filterInvites,
  formatExpiryDays,
  formatInviteeHop,
  formatShortDate,
  hopsWithAllowance,
  inviteListKind,
  inviteStatusFilterActive,
  INVITE_STATUS_LABELS,
  type InviteAllowance,
  type InviteeHop,
  type InviteListKind,
} from './inviteModel'
import styles from './InvitesCard.module.css'

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

type StatusFilter = InviteListKind | 'all'

export type InvitesCardVariant = 'default' | 'hero' | 'split'

export interface InvitesCardProps {
  /** Issued invites (pending / waiting / joined / closed). Empty slots are not rows. */
  slots: SlotData[]
  /** Per-hop totals from the user's positions. Null while loading. */
  allowance: InviteAllowance | null
  variant?: InvitesCardVariant
  /** Connected wallet — used to detect self-fill max-out exhaustion. */
  selfWalletAddress?: string
  onGenerateLink: (
    hop: InviteeHop,
  ) => Promise<{ id: number; link: string; expiresAt: Date } | void>
  onCopy: (inviteId: number, link: string) => void
  /** `link` identifies the invite link to revoke — prefer it over `inviteId`,
   *  which can go stale as live rows re-sort. */
  onRevoke: (inviteId: number, link?: string) => void | Promise<void>
  onConfirmCreated?: (inviteId: number) => void
  onDiscardCreated?: (inviteId: number) => void
  /** Commit deferred invites when leaving the panel mid-confirmation. */
  onFlushPending?: () => void
  onInviteOnchain: (
    hop: InviteeHop,
    address: string,
    ensName?: string,
  ) => Promise<{ id: number; address: string; ensName?: string } | void>
  copiedSlotId?: number | null
  loadingHop?: InviteeHop | null
  /** Open crowdfund with the invitee wallet selected. */
  onViewRedeemed?: (address: string) => void
  /** Fired when the sent-invites list expands or collapses. */
  onInviteListOpenChange?: (open: boolean) => void
  /**
   * When false (e.g. My Position panel hidden), the invites list collapses.
   * Defaults to true.
   */
  panelActive?: boolean
  /** Real ENS resolver — omit for showcase mock resolution. */
  resolveEns?: (
    input: string,
  ) => Promise<import('../InviteFlow/screens/SlotCard').SlotCardEnsResult>
}

function isSelfFillExhausted(
  invites: SlotData[],
  allowance: InviteAllowance | null,
  selfWalletAddress?: string,
): boolean {
  if (!selfWalletAddress || !allowance) return false
  const hops = hopsWithAllowance(allowance)
  if (hops.length === 0) return false
  const allUsed = hops.every((hop) => availableForHop(invites, allowance, hop) === 0)
  if (!allUsed) return false
  const self = selfWalletAddress.toLowerCase()
  const used = invites.filter((invite) =>
    invite.status === 'redeemed' ||
    invite.status === 'link-active' ||
    invite.status === 'onchain-pending',
  )
  return (
    used.length > 0 &&
    used.every(
      (invite) =>
        invite.status === 'redeemed' &&
        typeof invite.redeemedBy === 'string' &&
        invite.redeemedBy.toLowerCase() === self,
    )
  )
}

function hopVariantForInvitee(hop: InviteeHop): 'hop-1' | 'hop-2' {
  return hop === 1 ? 'hop-1' : 'hop-2'
}

/** Path + query only — e.g. `/join?invite=…` */
function inviteLinkPath(url: string): string {
  try {
    const parsed = new URL(url)
    const path = `${parsed.pathname}${parsed.search}${parsed.hash}`
    return path.startsWith('/') ? path : `/${path}`
  } catch {
    const scheme = url.indexOf('://')
    if (scheme >= 0) {
      const afterHost = url.indexOf('/', scheme + 3)
      if (afterHost >= 0) return url.slice(afterHost)
    }
    return url.startsWith('/') ? url : `/${url}`
  }
}

/** Split so CSS can ellipsize the start while keeping the end visible. */
function splitMiddleTruncate(value: string, endChars = 10): { start: string; end: string } {
  if (value.length <= endChars + 2) return { start: value, end: '' }
  return { start: value.slice(0, -endChars), end: value.slice(-endChars) }
}

function MiddleTruncateText({
  value,
  className,
  title,
}: {
  value: string
  className?: string
  title?: string
}) {
  const { start, end } = splitMiddleTruncate(value)
  if (!end) {
    return (
      <span className={className} title={title ?? value}>
        {value}
      </span>
    )
  }
  return (
    <span className={[styles.middleTruncate, className].filter(Boolean).join(' ')} title={title ?? value}>
      <span className={styles.middleTruncateStart}>{start}</span>
      <span className={styles.middleTruncateEnd}>{end}</span>
    </span>
  )
}

export function InvitesCard({
  slots,
  allowance,
  variant = 'default',
  selfWalletAddress,
  onGenerateLink,
  onCopy,
  onRevoke,
  onConfirmCreated,
  onDiscardCreated,
  onFlushPending,
  onInviteOnchain,
  copiedSlotId = null,
  loadingHop = null,
  onViewRedeemed,
  onInviteListOpenChange,
  panelActive = true,
  resolveEns,
}: InvitesCardProps) {
  const [listOpen, setListOpen] = useState(false)
  const [listContentVisible, setListContentVisible] = useState(false)
  const [listLayoutClosing, setListLayoutClosing] = useState(false)
  const [isShortViewport, setIsShortViewport] = useState(false)
  const [shortListExpanded, setShortListExpanded] = useState(false)
  const [shortCardPhase, setShortCardPhase] = useState<'exit' | 'enter' | null>(
    null,
  )
  const [shortCardAnimActive, setShortCardAnimActive] = useState(false)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const timersRef = useRef<number[]>([])
  const shortCardRafRef = useRef(0)
  // Latest flush handler, read by the panel-deactivation effect so a parent
  // passing a fresh closure each render doesn't re-trigger the flush.
  const onFlushPendingRef = useRef(onFlushPending)
  onFlushPendingRef.current = onFlushPending
  const focusApi = useInviteHopFocus()
  const listId = useId()
  const listBodyId = useId()

  const isActionView = focusApi.view === 'action'
  /** Snapshot of per-hop available counts when the invite action opened (pre-commit). */
  const actionAvailableSnapshotRef = useRef<Partial<Record<InviteeHop, number>> | null>(
    null,
  )
  const [rollFromByHop, setRollFromByHop] = useState<
    Partial<Record<InviteeHop, number>>
  >({})

  const selfFillExhausted = useMemo(
    () => isSelfFillExhausted(slots, allowance, selfWalletAddress),
    [slots, allowance, selfWalletAddress],
  )

  const hopRows = useMemo(() => {
    if (!allowance) return [] as InviteeHop[]
    return hopsWithAllowance(allowance)
  }, [allowance])

  const listableCount = useMemo(() => filterInvites(slots).length, [slots])
  const showStatusFilters = listableCount > 4
  const filtersActive =
    showStatusFilters && inviteStatusFilterActive(statusFilter)

  const filteredInvites = useMemo(() => {
    if (!showStatusFilters || statusFilter === 'all') return filterInvites(slots)
    return filterInvites(slots, new Set([statusFilter]))
  }, [slots, statusFilter, showStatusFilters])

  const totalAvailable = useMemo(() => {
    if (!allowance) return null
    return hopRows.reduce(
      (sum, hop) => sum + availableForHop(slots, allowance, hop),
      0,
    )
  }, [allowance, hopRows, slots])

  const showWhitelistCard =
    isActionView || totalAvailable == null || totalAvailable > 0
  /** Keep the sent-invites panel visible under the share/whitelist action card. */
  const showInvitesList = listableCount > 0 && !selfFillExhausted

  const listShellExpanded =
    listOpen && (!isShortViewport || shortListExpanded || !showWhitelistCard)

  const clearTimers = useCallback(() => {
    timersRef.current.forEach((id) => window.clearTimeout(id))
    timersRef.current = []
    cancelAnimationFrame(shortCardRafRef.current)
  }, [])

  const resetListAnimation = useCallback(() => {
    clearTimers()
    setListOpen(false)
    setListContentVisible(false)
    setListLayoutClosing(false)
    setShortListExpanded(false)
    setShortCardPhase(null)
    setShortCardAnimActive(false)
  }, [clearTimers])

  const runShortCardAnim = useCallback((phase: 'exit' | 'enter') => {
    setShortCardPhase(phase)
    setShortCardAnimActive(false)
    cancelAnimationFrame(shortCardRafRef.current)
    shortCardRafRef.current = requestAnimationFrame(() => {
      shortCardRafRef.current = requestAnimationFrame(() =>
        setShortCardAnimActive(true),
      )
    })
  }, [])

  const requestOpen = useCallback(() => {
    clearTimers()
    setListLayoutClosing(false)
    setListOpen(true)

    if (prefersReducedMotion()) {
      setShortListExpanded(true)
      setListContentVisible(true)
      setShortCardPhase(null)
      setShortCardAnimActive(false)
      return
    }

    // Match crowdfund short open: whitelist exit → list expand → content fade
    if (
      showWhitelistCard &&
      window.matchMedia(`(max-height: ${SHORT_VIEWPORT_MAX_HEIGHT_PX}px)`).matches
    ) {
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

    setShortListExpanded(true)
    const id = window.setTimeout(() => {
      setListContentVisible(true)
    }, CROWDFUND_LIST_EXPAND_MS)
    timersRef.current.push(id)
  }, [clearTimers, runShortCardAnim, showWhitelistCard])

  const requestClose = useCallback(() => {
    clearTimers()
    setListContentVisible(false)

    if (prefersReducedMotion()) {
      resetListAnimation()
      return
    }

    // Match crowdfund short close: content fade → retract → whitelist re-enter
    if (
      showWhitelistCard &&
      window.matchMedia(`(max-height: ${SHORT_VIEWPORT_MAX_HEIGHT_PX}px)`).matches
    ) {
      const startCollapseId = window.setTimeout(() => {
        setListLayoutClosing(true)
      }, CROWDFUND_LIST_CONTENT_FADE_MS)
      const showCardId = window.setTimeout(() => {
        setListLayoutClosing(false)
        runShortCardAnim('enter')
      }, CROWDFUND_LIST_CONTENT_FADE_MS + CROWDFUND_LIST_EXPAND_MS)
      const finishId = window.setTimeout(() => {
        setListOpen(false)
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
      setListOpen(false)
      setListLayoutClosing(false)
      setShortListExpanded(false)
    }, CROWDFUND_LIST_EXPAND_MS + CROWDFUND_LIST_EXPAND_MS)
    timersRef.current.push(collapseId, finishId)
  }, [clearTimers, resetListAnimation, runShortCardAnim, showWhitelistCard])

  const inviteChromeOpen = listOpen || isActionView

  useEffect(() => {
    onInviteListOpenChange?.(inviteChromeOpen)
  }, [inviteChromeOpen, onInviteListOpenChange])

  // Snapshot available counts when entering the invite action; when returning to the
  // list after a successful send, roll the hop thumb from the pre-commit value.
  useEffect(() => {
    if (isActionView) {
      if (actionAvailableSnapshotRef.current == null && allowance) {
        const snap: Partial<Record<InviteeHop, number>> = {}
        for (const hop of hopsWithAllowance(allowance)) {
          snap[hop] = availableForHop(slots, allowance, hop)
        }
        actionAvailableSnapshotRef.current = snap
      }
      return
    }

    const snap = actionAvailableSnapshotRef.current
    actionAvailableSnapshotRef.current = null
    if (!snap || !allowance) return

    const next: Partial<Record<InviteeHop, number>> = {}
    let changed = false
    for (const hop of hopsWithAllowance(allowance)) {
      const from = snap[hop]
      const to = availableForHop(slots, allowance, hop)
      if (from != null && from > to) {
        next[hop] = from
        changed = true
      }
    }
    if (changed) setRollFromByHop(next)
  }, [isActionView, slots, allowance])

  useEffect(() => clearTimers, [clearTimers])

  useEffect(() => {
    const mq = window.matchMedia(
      `(max-height: ${SHORT_VIEWPORT_MAX_HEIGHT_PX}px)`,
    )
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

  // Collapse when leaving My Position (or any inactive panel) — never restore expanded.
  // Flush deferred creates so they aren't lost mid-confirmation.
  useEffect(() => {
    if (!panelActive) {
      resetListAnimation()
      onFlushPendingRef.current?.()
    }
  }, [panelActive, resetListAnimation])

  // Hide entire component when the user has no invite rights at any hop.
  if (allowance && hopRows.length === 0 && !isActionView) {
    return null
  }

  if (!showWhitelistCard && !showInvitesList) {
    return null
  }

  const openInvitePicker = (hop: InviteeHop, anchor: HTMLElement) => {
    focusApi.openPicker(hop, anchor)
  }

  const handleInviteBack = () => {
    focusApi.goBack()
  }

  const toggleListOpen = () => {
    if (listOpen) requestClose()
    else requestOpen()
  }

  const hopRowsEl = (
    <div className={styles.hopList} role="list">
      {allowance == null
        ? (
            <>
              <HopAvailableRow hop={1} available={0} loading onInviteClick={() => {}} />
              <HopAvailableRow hop={2} available={0} loading onInviteClick={() => {}} />
            </>
          )
        : hopRows.map((hop) => {
            const available = availableForHop(slots, allowance, hop)
            return (
              <HopAvailableRow
                key={hop}
                hop={hop}
                available={available}
                rollFrom={rollFromByHop[hop]}
                loading={false}
                pickerOpen={focusApi.pickerHop === hop}
                onInviteClick={openInvitePicker}
                inviteButtonRef={(el) => focusApi.registerInviteButton(hop, el)}
                onRollComplete={() =>
                  setRollFromByHop((prev) => {
                    if (prev[hop] == null) return prev
                    const next = { ...prev }
                    delete next[hop]
                    return next
                  })
                }
              />
            )
          })}
    </div>
  )

  const hopBody = selfFillExhausted ? (
    <div className={styles.emptyState} role="status">
      <p className={styles.emptyTitle}>No invites left</p>
      <p className={styles.emptyBody}>
        You used all invite slots on yourself to max out your commit. Those slots are no
        longer available to whitelist friends.
      </p>
    </div>
  ) : (
    hopRowsEl
  )

  const stackClass = [
    styles.stack,
    variant === 'hero' && styles.stackHero,
    variant === 'split' && styles.stackSplit,
    listShellExpanded && styles.stackListOpen,
    listLayoutClosing && styles.stackListClosing,
    shortCardPhase === 'exit' && styles.stackShortCardExiting,
    shortCardPhase === 'exit' &&
      shortCardAnimActive &&
      styles.stackShortCardExitingActive,
    shortCardPhase === 'enter' && styles.stackShortCardEntering,
    shortCardPhase === 'enter' &&
      shortCardAnimActive &&
      styles.stackShortCardEnteringActive,
    isShortViewport &&
      shortListExpanded &&
      listOpen &&
      shortCardPhase !== 'enter' &&
      styles.stackShortCardDone,
  ]
    .filter(Boolean)
    .join(' ')

  const rootClass = [
    styles.root,
    isActionView && styles.rootAction,
  ]
    .filter(Boolean)
    .join(' ')

  const listPanelClass = [
    styles.listPanel,
    !listOpen && styles.listPanelCollapsed,
    listShellExpanded && styles.listPanelOpen,
    listLayoutClosing && styles.listPanelClosing,
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className={stackClass}>
      {showWhitelistCard && (
      <section
        className={rootClass}
        aria-label="Whitelist a friend"
        data-invite-surface=""
      >
        {isActionView && focusApi.focusHop != null ? null : (
          <div className={styles.header}>
            <h2 className={styles.title}>Whitelist a friend</h2>
          </div>
        )}

        <div
          className={[
            styles.slotList,
            isActionView && styles.slotListAction,
          ]
            .filter(Boolean)
            .join(' ')}
        >
          <InviteHopFocusChrome
            focusApi={{
              ...focusApi,
              goBack: handleInviteBack,
            }}
            loadingHop={loadingHop}
            onGenerateLink={onGenerateLink}
            onInviteOnchain={onInviteOnchain}
            onCopy={onCopy}
            onRevoke={onRevoke}
            onConfirmCreated={onConfirmCreated}
            onDiscardCreated={onDiscardCreated}
            copiedInviteId={copiedSlotId}
            resolveEns={resolveEns}
            list={hopBody}
          />
        </div>
      </section>
      )}

      {showInvitesList && (
        <section
          className={listPanelClass}
          id={listId}
          aria-label="Your invites"
        >
          <div
            className={[
              styles.listControls,
              !listShellExpanded && styles.listControlsCollapsed,
            ]
              .filter(Boolean)
              .join(' ')}
          >
            <h3 className={styles.listTitle}>Your invites</h3>
            <div className={styles.listActions}>
              <button
                type="button"
                className={styles.listToggleBtn}
                onClick={toggleListOpen}
                aria-expanded={listOpen}
                aria-controls={listBodyId}
              >
                {listOpen ? 'Hide' : 'Show more'}
                {listOpen ? (
                  <ChevronUpIcon className={styles.listToggleIcon} aria-hidden />
                ) : (
                  <ChevronDownIcon
                    className={styles.listToggleIcon}
                    aria-hidden
                  />
                )}
              </button>
            </div>
          </div>

          <div className={styles.listExpand} aria-hidden={!listShellExpanded}>
            <div className={styles.listExpandInner}>
              <div
                className={[
                  styles.listBody,
                  listContentVisible && styles.listBodyReady,
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
                {showStatusFilters && (
                  <div
                    className={styles.statusFilters}
                    role="tablist"
                    aria-label="Invite status filters"
                  >
                    <button
                      type="button"
                      role="tab"
                      className={[
                        styles.statusPill,
                        statusFilter === 'all' && styles.statusPillActive,
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      aria-selected={statusFilter === 'all'}
                      tabIndex={listContentVisible ? 0 : -1}
                      onClick={() => setStatusFilter('all')}
                    >
                      All
                    </button>
                    {ALL_INVITE_STATUSES.map((status) => (
                      <button
                        key={status}
                        type="button"
                        role="tab"
                        className={[
                          styles.statusPill,
                          statusFilter === status && styles.statusPillActive,
                        ]
                          .filter(Boolean)
                          .join(' ')}
                        aria-selected={statusFilter === status}
                        tabIndex={listContentVisible ? 0 : -1}
                        onClick={() => setStatusFilter(status)}
                      >
                        {INVITE_STATUS_LABELS[status]}
                      </button>
                    ))}
                  </div>
                )}

                <p className={styles.srOnly} aria-live="polite">
                  {filtersActive
                    ? `${filteredInvites.length} of ${listableCount} invites`
                    : `${listableCount} invite${listableCount === 1 ? '' : 's'}`}
                </p>

                <div className={styles.listScroll} id={listBodyId}>
                  {filteredInvites.length === 0 ? (
                    <p className={styles.listEmpty} role="status">
                      No invites match. Try a different filter.
                    </p>
                  ) : (
                    <ul className={styles.inviteList}>
                      {filteredInvites.map((invite, index) => (
                        <li key={invite.id} className={styles.inviteListItem}>
                          <InviteListRow
                            invite={invite}
                            index={index}
                            copied={copiedSlotId === invite.id}
                            onCopy={onCopy}
                            onRevoke={onRevoke}
                            onView={onViewRedeemed}
                          />
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </div>
          </div>
        </section>
      )}
    </div>
  )
}

// ── Hop available row ───────────────────────────────────────────────────────

export interface HopAvailableRowProps {
  hop: InviteeHop
  available: number
  /** When set (> available), thumb counts down from this value after list re-enters. */
  rollFrom?: number
  loading?: boolean
  pickerOpen?: boolean
  onInviteClick: (hop: InviteeHop, anchor: HTMLElement) => void
  inviteButtonRef?: (el: HTMLButtonElement | null) => void
  onRollComplete?: () => void
}

function HopThumbCount({
  available,
  rollFrom,
  onRollComplete,
}: {
  available: number
  rollFrom?: number
  onRollComplete?: () => void
}) {
  const shouldRoll = rollFrom != null && rollFrom > available
  const [stripOffset, setStripOffset] = useState(0)
  const [rolling, setRolling] = useState(false)
  const onRollCompleteRef = useRef(onRollComplete)
  onRollCompleteRef.current = onRollComplete

  const steps = useMemo(() => {
    if (!shouldRoll || rollFrom == null) return [available]
    const values: number[] = []
    for (let n = rollFrom; n >= available; n -= 1) values.push(n)
    return values
  }, [shouldRoll, rollFrom, available])

  useEffect(() => {
    if (!shouldRoll) {
      setStripOffset(0)
      setRolling(false)
      return
    }

    setStripOffset(0)
    setRolling(false)

    if (prefersReducedMotion()) {
      setStripOffset(steps.length - 1)
      onRollCompleteRef.current?.()
      return
    }

    const startId = window.setTimeout(() => {
      // Double rAF so the browser paints the "from" frame before transitioning.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setRolling(true)
          setStripOffset(steps.length - 1)
        })
      })
    }, INVITE_COUNT_ROLL_DELAY_MS)

    const doneId = window.setTimeout(() => {
      setRolling(false)
      onRollCompleteRef.current?.()
    }, INVITE_COUNT_ROLL_DELAY_MS + INVITE_COUNT_ROLL_MS)

    return () => {
      window.clearTimeout(startId)
      window.clearTimeout(doneId)
    }
  }, [shouldRoll, steps.length, available, rollFrom])

  if (!shouldRoll) {
    return <span className={styles.hopThumbCount}>{available}</span>
  }

  return (
    <span className={styles.hopThumbCountViewport} aria-hidden>
      <span
        className={[
          styles.hopThumbCountStrip,
          rolling && styles.hopThumbCountStripRolling,
        ]
          .filter(Boolean)
          .join(' ')}
        style={
          {
            transform: `translateY(calc(${stripOffset} * -100%))`,
            '--invite-count-roll-ms': `${INVITE_COUNT_ROLL_MS}ms`,
          } as CSSProperties
        }
      >
        {steps.map((n) => (
          <span key={n} className={styles.hopThumbCount}>
            {n}
          </span>
        ))}
      </span>
    </span>
  )
}

export function HopAvailableRow({
  hop,
  available,
  rollFrom,
  loading = false,
  pickerOpen = false,
  onInviteClick,
  inviteButtonRef,
  onRollComplete,
}: HopAvailableRowProps) {
  const btnRef = useRef<HTMLButtonElement>(null)
  const hopColor = hopPillDotColor(hopVariantForInvitee(hop))
  const hopName = formatInviteeHop(hop)
  const label = `Invite to ${hopName}`
  const invitesLeft =
    available === 1 ? '1 invite left' : `${available} invites left`

  useEffect(() => {
    inviteButtonRef?.(btnRef.current)
    return () => inviteButtonRef?.(null)
  }, [inviteButtonRef])

  return (
    <div className={styles.hopRow} role="listitem">
      <div className={styles.row}>
        <div
          className={styles.hopThumb}
          style={{
            background: `color-mix(in srgb, ${hopColor} 16%, var(--semantic-color-surface-default))`,
          }}
          aria-hidden={loading ? undefined : true}
        >
          {loading ? (
            <span className={styles.hopThumbSkeleton} aria-label="Loading available invites" />
          ) : (
            <HopThumbCount
              available={available}
              rollFrom={rollFrom}
              onRollComplete={onRollComplete}
            />
          )}
        </div>
        <div className={styles.hopMeta}>
          {loading ? (
            <span className={styles.hopThumbSkeleton} aria-label="Loading available invites" />
          ) : (
            <span className={styles.hopLabelRow}>
              <span
                className={styles.hopDot}
                style={{ background: hopColor }}
                aria-hidden
              />
              <span className={styles.hopLabel}>{label}</span>
            </span>
          )}
        </div>
        <div className={styles.rowActions}>
          {!loading && available > 0 && (
            <Button
              ref={btnRef}
              variant="secondary"
              size="sm"
              label={invitesLeft}
              showIcon={false}
              onClick={(e) => onInviteClick(hop, e.currentTarget)}
              aria-label={`${label}, ${invitesLeft}`}
              aria-haspopup="menu"
              aria-expanded={pickerOpen}
            />
          )}
        </div>
      </div>
      {!loading && (
        <p className={styles.srOnly} aria-live="polite">
          {invitesLeft}
        </p>
      )}
    </div>
  )
}

// ── Invite list row ─────────────────────────────────────────────────────────

interface InviteListRowProps {
  invite: SlotData
  index: number
  copied: boolean
  onCopy: (id: number, link: string) => void
  onRevoke: (id: number, link?: string) => void | Promise<void>
  onView?: (address: string) => void
}

function InviteListRow({
  invite,
  index,
  copied,
  onCopy,
  onRevoke,
  onView,
}: InviteListRowProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuPos, setMenuPos] = useState<{ bottom: number; right: number } | null>(
    null,
  )
  const [revokeConfirmOpen, setRevokeConfirmOpen] = useState(false)
  const [revokePopoverPos, setRevokePopoverPos] = useState<{
    top: number
    left: number
  } | null>(null)
  const [revoking, setRevoking] = useState(false)
  const menuWrapRef = useRef<HTMLDivElement>(null)
  const moreBtnRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLUListElement>(null)
  const revokePopoverRef = useRef<HTMLDivElement>(null)
  const menuId = useId()
  const revokeTitleId = useId()
  const kind = inviteListKind(invite)
  const hop = invite.inviteeHop === 2 ? 2 : 1
  const hopColor = hopPillDotColor(hopVariantForInvitee(hop))
  const hopTag = hop === 1 ? 'HOP-1' : 'HOP-2'

  const updateRevokePopoverPosition = () => {
    const anchor = moreBtnRef.current
    if (!anchor) return
    const rect = anchor.getBoundingClientRect()
    const popover = revokePopoverRef.current
    const popoverHeight = popover?.offsetHeight ?? 160
    const popoverWidth = popover?.offsetWidth ?? 220
    const gap = 6
    const viewportMargin = 20
    const isMobile = window.matchMedia('(max-width: 767px)').matches

    if (isMobile) {
      let left = rect.right - popoverWidth
      left = Math.max(
        viewportMargin,
        Math.min(left, window.innerWidth - popoverWidth - viewportMargin),
      )
      let top = rect.top - gap - popoverHeight
      if (top < viewportMargin) {
        top = Math.min(
          rect.bottom + gap,
          window.innerHeight - popoverHeight - viewportMargin,
        )
      }
      setRevokePopoverPos({ top, left })
      return
    }

    let top = rect.top - gap - popoverHeight
    if (top < viewportMargin) {
      top = rect.bottom + gap
    }
    setRevokePopoverPos({ top, left: rect.right })
  }

  useEffect(() => {
    if (!menuOpen) {
      setMenuPos(null)
      return
    }

    const updatePos = () => {
      const btn = moreBtnRef.current
      if (!btn) return
      const rect = btn.getBoundingClientRect()
      setMenuPos({
        bottom: window.innerHeight - rect.top + 4,
        right: Math.max(8, window.innerWidth - rect.right),
      })
    }

    updatePos()
    window.addEventListener('resize', updatePos)
    window.addEventListener('scroll', updatePos, true)
    return () => {
      window.removeEventListener('resize', updatePos)
      window.removeEventListener('scroll', updatePos, true)
    }
  }, [menuOpen])

  useEffect(() => {
    if (!menuOpen) return
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node
      if (menuWrapRef.current?.contains(target)) return
      if (menuRef.current?.contains(target)) return
      setMenuOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [menuOpen])

  useLayoutEffect(() => {
    if (!revokeConfirmOpen) {
      setRevokePopoverPos(null)
      return
    }
    updateRevokePopoverPosition()
  }, [revokeConfirmOpen, revoking])

  useEffect(() => {
    if (!revokeConfirmOpen) return

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setRevokeConfirmOpen(false)
    }
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node
      if (moreBtnRef.current?.contains(target)) return
      if (revokePopoverRef.current?.contains(target)) return
      setRevokeConfirmOpen(false)
    }
    const onReposition = () => updateRevokePopoverPosition()

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('resize', onReposition)
    window.addEventListener('scroll', onReposition, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('resize', onReposition)
      window.removeEventListener('scroll', onReposition, true)
    }
  }, [revokeConfirmOpen])

  if (kind == null) return null

  const toggleMenu = () => {
    if (revokeConfirmOpen) {
      setRevokeConfirmOpen(false)
      return
    }
    setMenuOpen((open) => {
      if (open) return false
      const btn = moreBtnRef.current
      if (btn) {
        const rect = btn.getBoundingClientRect()
        setMenuPos({
          bottom: window.innerHeight - rect.top + 4,
          right: Math.max(8, window.innerWidth - rect.right),
        })
      }
      return true
    })
  }

  const handleConfirmRevoke = async () => {
    setRevoking(true)
    try {
      await onRevoke(invite.id, invite.link)
    } finally {
      setRevoking(false)
      setRevokeConfirmOpen(false)
    }
  }

  let label = ''
  let meta = ''
  let addressForView: string | undefined
  let isLinkPath = false
  let isMono = false

  if (kind === 'link-pending' && invite.link) {
    label = inviteLinkPath(invite.link)
    meta = invite.expiresAt
      ? `Link pending · ${formatExpiryDays(invite.expiresAt)}`
      : 'Link pending'
    isLinkPath = true
    isMono = true
  } else if (kind === 'waiting' && invite.invitedAddress) {
    label = invite.ensName ?? truncateAddress(invite.invitedAddress)
    meta = invite.invitedAt
      ? `Waiting to commit · Invited ${formatShortDate(invite.invitedAt)}`
      : 'Waiting to commit'
    addressForView = invite.invitedAddress
    isMono = !invite.ensName
  } else if (kind === 'joined') {
    label = invite.redeemedBy ? truncateAddress(invite.redeemedBy) : 'Joined'
    meta = invite.joinedAt ? `Joined on ${formatShortDate(invite.joinedAt)}` : 'Joined'
    addressForView = invite.redeemedBy
    isMono = true
  } else if (kind === 'closed') {
    label = invite.link ? inviteLinkPath(invite.link) : 'Closed link'
    meta =
      invite.status === 'revoked'
        ? 'Link revoked · Slot is available again'
        : 'Link expired · Slot is available again'
    isLinkPath = Boolean(invite.link)
    isMono = Boolean(invite.link)
  }

  const hasActions =
    kind === 'link-pending' ||
    ((kind === 'waiting' || kind === 'joined') && Boolean(addressForView && onView))

  return (
    <div
      className={[styles.listRow, kind === 'closed' && styles.listRowMuted]
        .filter(Boolean)
        .join(' ')}
    >
      <span className={styles.listRank}>{index + 1}</span>
      <div className={styles.labelStack}>
        <span className={styles.metaLine}>
          <span className={styles.listHop}>
            <span
              className={styles.listHopDot}
              style={{ background: hopColor }}
              aria-hidden
            />
            {hopTag}
          </span>
          <span className={styles.metaSep} aria-hidden>
            ·
          </span>
          <span className={styles.metaLabel}>{meta}</span>
        </span>
        {isLinkPath ? (
          <MiddleTruncateText value={label} className={styles.linkLabel} />
        ) : (
          <span className={isMono ? styles.linkLabel : styles.addressLabel}>{label}</span>
        )}
      </div>
      {hasActions ? (
        <div className={styles.rowMenu} ref={menuWrapRef}>
          <button
            ref={moreBtnRef}
            type="button"
            className={styles.moreBtn}
            aria-label="Invite actions"
            aria-haspopup="menu"
            aria-expanded={menuOpen || revokeConfirmOpen}
            aria-controls={
              menuOpen ? menuId : revokeConfirmOpen ? revokeTitleId : undefined
            }
            onClick={toggleMenu}
          >
            <EllipsisHorizontalIcon className={styles.moreIcon} aria-hidden />
          </button>
          {menuOpen &&
            menuPos &&
            createPortal(
              <ul
                ref={menuRef}
                id={menuId}
                className={styles.moreMenu}
                role="menu"
                style={{ bottom: menuPos.bottom, right: menuPos.right }}
              >
                {kind === 'link-pending' && invite.link && (
                  <>
                    <li role="none">
                      <button
                        type="button"
                        role="menuitem"
                        className={styles.moreMenuItem}
                        onClick={() => {
                          onCopy(invite.id, invite.link!)
                          setMenuOpen(false)
                        }}
                      >
                        {copied ? 'Copied' : 'Copy link'}
                      </button>
                    </li>
                    <li role="none">
                      <button
                        type="button"
                        role="menuitem"
                        className={styles.moreMenuItem}
                        onClick={() => {
                          setMenuOpen(false)
                          setRevokeConfirmOpen(true)
                        }}
                      >
                        Revoke
                      </button>
                    </li>
                  </>
                )}
                {(kind === 'waiting' || kind === 'joined') &&
                  addressForView &&
                  onView && (
                    <li role="none">
                      <button
                        type="button"
                        role="menuitem"
                        className={styles.moreMenuItem}
                        onClick={() => {
                          setMenuOpen(false)
                          onView(addressForView!)
                        }}
                      >
                        View
                      </button>
                    </li>
                  )}
              </ul>,
              document.body,
            )}
          {revokeConfirmOpen &&
            revokePopoverPos &&
            createPortal(
              <div
                ref={revokePopoverRef}
                className={styles.revokePopover}
                role="dialog"
                aria-modal="false"
                aria-labelledby={revokeTitleId}
                style={{ top: revokePopoverPos.top, left: revokePopoverPos.left }}
              >
                <p id={revokeTitleId} className={styles.revokeTitle}>
                  Revoke invite link?
                </p>
                <p className={styles.revokeBody}>
                  This link will stop working. You can generate a new one anytime.
                </p>
                <div className={styles.revokeActions}>
                  <Button
                    variant="secondary"
                    size="sm"
                    label={revoking ? 'Revoking…' : 'Revoke link'}
                    showIcon={false}
                    className={styles.revokeConfirmBtn}
                    onClick={() => void handleConfirmRevoke()}
                    disabled={revoking}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    label="Cancel"
                    showIcon={false}
                    className={styles.revokeCancelBtn}
                    onClick={() => setRevokeConfirmOpen(false)}
                    disabled={revoking}
                  />
                </div>
              </div>,
              document.body,
            )}
        </div>
      ) : (
        <span className={styles.listActionsSpacer} aria-hidden />
      )}
    </div>
  )
}
