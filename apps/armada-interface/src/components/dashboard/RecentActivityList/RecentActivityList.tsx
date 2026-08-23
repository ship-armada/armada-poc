// ABOUTME: Dashboard recent-activity preview — icon-badge rows with scrambled amounts + a "View all" link.
// ABOUTME: Presentation ported from the armada-app mockup; driven by real tx data via DashboardActivityItem.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type CSSProperties,
  type SVGProps,
  type UIEvent,
} from 'react'
import {
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ChartBarIcon,
  ClockIcon,
  LinkIcon,
  NoSymbolIcon,
  PlusIcon,
  QuestionMarkCircleIcon,
} from '@heroicons/react/24/outline'
import { BalanceScrambleValue } from '@/components/dashboard/BalanceScrambleValue'
import { formatUsdcAmount, formatTimeAgo } from '@/components/dashboard/dashboardFormat'
import { formatPaymentLinkExpiry } from '@/lib/payViaLink'
import type {
  DashboardActivityItem,
  DashboardActivityKind,
  DashboardActivityStatus,
} from '@/components/dashboard/txActivityAdapter'
import usdcAmount from '@/design/styles/usdcAmount.module.css'
import { hidePeekEventHandlers } from '@/hooks/useHidePeek'
import { useMobileLayout } from '@/hooks/useMobileLayout'
import styles from './RecentActivityList.module.css'

/** Bottom-fade height for the scrollable preview viewport. */
const ACTIVITY_LIST_FADE_HEIGHT_PX = 72

const ACTIVITY_ICONS: Record<DashboardActivityKind, ComponentType<SVGProps<SVGSVGElement>>> = {
  send: ArrowRightIcon,
  deposit: PlusIcon,
  earn: ChartBarIcon,
  withdraw: ArrowLeftIcon,
  receive: ArrowDownIcon,
  requestLink: LinkIcon,
}

function formatActivityAmount(item: DashboardActivityItem): string {
  const absolute = formatUsdcAmount(Math.abs(item.amount))
  // A created link moves no funds — show the requested amount with no +/- sign.
  if (item.kind === 'requestLink') return absolute
  if (item.amount > 0) return `+${absolute}`
  if (item.amount < 0) return `-${absolute}`
  return absolute
}

/** Subtitle status prefix per outcome (settled shows just the time). */
const STATUS_PREFIX: Record<DashboardActivityStatus, string | null> = {
  settled: null,
  pending: 'Pending',
  failed: 'Failed',
  cancelled: 'Cancelled',
  unknown: 'Unknown',
}

function formatActivitySubtitle(item: DashboardActivityItem): string {
  const timeAgo = formatTimeAgo(item.occurredAt)
  if (item.kind === 'requestLink' && item.expiresAt !== undefined) {
    return `${timeAgo} • ${formatPaymentLinkExpiry(item.expiresAt)}`
  }
  const prefix = STATUS_PREFIX[item.status]
  return prefix ? `${prefix} • ${timeAgo}` : timeAgo
}

function activityAmountTone(item: DashboardActivityItem, balanceRevealed: boolean): string {
  // Failed → struck red; cancelled → struck muted; both regardless of reveal (the strike, not the
  // digits, carries the meaning).
  if (item.status === 'failed') return styles.amountFailed ?? ''
  if (item.status === 'cancelled') return styles.amountCancelled ?? ''
  // Pending, unknown (may still settle), request-link rows, and hidden balances read neutral.
  if (!balanceRevealed || item.pending || item.status === 'unknown' || item.kind === 'requestLink') {
    return ''
  }
  if (item.amount > 0) return styles.amountPositive ?? ''
  if (item.amount < 0) return styles.amountNegative ?? ''
  return ''
}

export type RecentActivityListVariant = 'preview' | 'full'

export interface RecentActivityListProps {
  items: readonly DashboardActivityItem[]
  balanceRevealed?: boolean
  variant?: RecentActivityListVariant
  onViewAll?: () => void
  onItemClick?: (item: DashboardActivityItem) => void
}

function ActivityListItems({
  items,
  balanceRevealed,
  onItemClick,
}: {
  items: readonly DashboardActivityItem[]
  balanceRevealed: boolean
  onItemClick?: (item: DashboardActivityItem) => void
}) {
  const isMobile = useMobileLayout()
  const [peekedId, setPeekedId] = useState<string | null>(null)
  // Animate only a freshly-prepended top row (not the whole list, and not on first paint — the
  // list-level enter handles that). Mirrors the mockup's enteringId/skipEnter.
  const [enteringId, setEnteringId] = useState<string | null>(null)
  const seenFirstIdRef = useRef<string | null>(null)
  const skipEnterRef = useRef(true)
  useEffect(() => {
    const firstId = items[0]?.id ?? null
    if (skipEnterRef.current) {
      skipEnterRef.current = false
      seenFirstIdRef.current = firstId
      return
    }
    if (firstId && firstId !== seenFirstIdRef.current) {
      setEnteringId(firstId)
      seenFirstIdRef.current = firstId
    }
  }, [items])

  return (
    <ul className={styles.list}>
      {items.map((item) => {
        const amountLabel = formatActivityAmount(item)
        const itemRevealed = balanceRevealed || peekedId === item.id
        const amountTone = activityAmountTone(item, itemRevealed)
        // Failed / cancelled rows strike both the amount and the description — nothing settled.
        const struck = item.status === 'failed' || item.status === 'cancelled'
        // Status overrides the kind icon: failed/cancelled → "no" symbol, unknown → question mark.
        const Icon =
          item.status === 'unknown'
            ? QuestionMarkCircleIcon
            : struck
              ? NoSymbolIcon
              : ACTIVITY_ICONS[item.kind]
        const peekHandlers = hidePeekEventHandlers(
          !balanceRevealed,
          () => setPeekedId(item.id),
          () => setPeekedId((current) => (current === item.id ? null : current)),
          isMobile,
        )

        return (
          <li key={item.id}>
            <button
              type="button"
              className={[styles.item, enteringId === item.id ? styles.itemEnter : '']
                .filter(Boolean)
                .join(' ')}
              onClick={() => onItemClick?.(item)}
              {...peekHandlers}
            >
              <span className={styles.iconBadge} aria-hidden>
                <Icon className={styles.icon} strokeWidth={1.5} />
              </span>
              <div className={styles.copy}>
                <span className={[styles.label, struck && styles.labelStruck].filter(Boolean).join(' ')}>
                  {item.label}
                </span>
                <span className={styles.time}>{formatActivitySubtitle(item)}</span>
              </div>
              <span
                className={[styles.amount, usdcAmount.font, amountTone].filter(Boolean).join(' ')}
                aria-label={itemRevealed ? amountLabel : 'Amount hidden'}
              >
                <BalanceScrambleValue value={amountLabel} revealed={itemRevealed} struck={struck} />
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}

export function RecentActivityList({
  items,
  balanceRevealed = true,
  variant = 'preview',
  onViewAll,
  onItemClick,
}: RecentActivityListProps) {
  const [showBottomFade, setShowBottomFade] = useState(false)
  const listScrollRef = useRef<HTMLDivElement>(null)
  const isPreview = variant === 'preview'

  const updateBottomFade = useCallback(() => {
    const el = listScrollRef.current
    if (!el) {
      setShowBottomFade(false)
      return
    }
    const canScroll = el.scrollHeight > el.clientHeight + 1
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 2
    setShowBottomFade(canScroll && !atBottom)
  }, [])

  useEffect(() => {
    if (!isPreview) {
      setShowBottomFade(false)
      return
    }
    updateBottomFade()
    const el = listScrollRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => updateBottomFade())
    observer.observe(el)
    return () => observer.disconnect()
  }, [isPreview, items, updateBottomFade])

  function handleListScroll(event: UIEvent<HTMLDivElement>) {
    const el = event.currentTarget
    const canScroll = el.scrollHeight > el.clientHeight + 1
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 2
    setShowBottomFade(canScroll && !atBottom)
  }

  const rootClassName = [styles.root, isPreview ? styles.rootPreview : styles.rootFull]
    .filter(Boolean)
    .join(' ')

  const previewStyle = {
    '--activity-list-fade-height': `${ACTIVITY_LIST_FADE_HEIGHT_PX}px`,
  } as CSSProperties

  return (
    <section
      className={rootClassName}
      aria-label="Recent activity"
      style={isPreview ? previewStyle : undefined}
    >
      {isPreview ? (
        <div className={styles.headerRow}>
          <h2 className={styles.heading}>Recent activity</h2>
          {onViewAll ? (
            <button type="button" className={styles.viewAllButton} onClick={onViewAll}>
              View all
            </button>
          ) : null}
        </div>
      ) : null}

      {items.length === 0 ? (
        <div className={styles.emptyState}>
          <span className={styles.emptyIconBadge} aria-hidden>
            <ClockIcon className={styles.emptyIcon} strokeWidth={1.5} />
          </span>
          <p className={styles.emptyTitle}>No activity yet</p>
          <p className={styles.emptyBody}>
            Shields, sends, and earn moves will show up here.
          </p>
        </div>
      ) : isPreview ? (
        <div className={styles.listViewport}>
          <div
            ref={listScrollRef}
            className={[styles.listScroll, showBottomFade && styles.listScrollFaded]
              .filter(Boolean)
              .join(' ')}
            onScroll={handleListScroll}
          >
            <ActivityListItems
              items={items}
              balanceRevealed={balanceRevealed}
              onItemClick={onItemClick}
            />
          </div>
        </div>
      ) : (
        <ActivityListItems
          items={items}
          balanceRevealed={balanceRevealed}
          onItemClick={onItemClick}
        />
      )}
    </section>
  )
}
