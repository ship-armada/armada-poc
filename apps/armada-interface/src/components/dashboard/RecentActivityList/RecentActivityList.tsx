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
  PlusIcon,
} from '@heroicons/react/24/outline'
import { BalanceScrambleValue } from '@/components/dashboard/BalanceScrambleValue'
import { formatUsdcAmount, formatTimeAgo } from '@/components/dashboard/dashboardFormat'
import type { DashboardActivityItem, DashboardActivityKind } from '@/components/dashboard/txActivityAdapter'
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
}

function formatActivityAmount(item: DashboardActivityItem): string {
  const absolute = formatUsdcAmount(Math.abs(item.amount))
  if (item.amount > 0) return `+${absolute}`
  if (item.amount < 0) return `-${absolute}`
  return absolute
}

function formatActivitySubtitle(item: DashboardActivityItem): string {
  const timeAgo = formatTimeAgo(item.occurredAt)
  return item.pending ? `Pending • ${timeAgo}` : timeAgo
}

function activityAmountTone(item: DashboardActivityItem, balanceRevealed: boolean): string {
  // Pending rows and hidden balances read neutral — no green/red inflow/outflow tint.
  if (!balanceRevealed || item.pending) return ''
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

  return (
    <ul className={styles.list}>
      {items.map((item) => {
        const Icon = ACTIVITY_ICONS[item.kind]
        const amountLabel = formatActivityAmount(item)
        const itemRevealed = balanceRevealed || peekedId === item.id
        const amountTone = activityAmountTone(item, itemRevealed)
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
              className={styles.item}
              onClick={() => onItemClick?.(item)}
              {...peekHandlers}
            >
              <span className={styles.iconBadge} aria-hidden>
                <Icon className={styles.icon} strokeWidth={1.5} />
              </span>
              <div className={styles.copy}>
                <span className={styles.label}>{item.label}</span>
                <span className={styles.time}>{formatActivitySubtitle(item)}</span>
              </div>
              <span
                className={[styles.amount, usdcAmount.font, amountTone].filter(Boolean).join(' ')}
                aria-label={itemRevealed ? amountLabel : 'Amount hidden'}
              >
                <BalanceScrambleValue value={amountLabel} revealed={itemRevealed} />
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
            Deposits, sends, and earn moves will show up here.
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
