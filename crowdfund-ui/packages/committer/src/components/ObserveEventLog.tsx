// ABOUTME: Observe-page event log — committer-styled port of the admin EventLog.
// ABOUTME: Reverse-chronological, type-filter pills (mapped to our semantic tokens), address search, per-type formatted rows with tx links, and "load more". Styled like the other Observe cards.

import { useMemo, useState } from 'react'
import type { JsonRpcProvider } from 'ethers'
import {
  formatUsdc,
  formatArm,
  truncateAddress,
  useENS,
  type CrowdfundEvent,
  type CrowdfundEventType,
} from '@armada/crowdfund-shared'
import { getExplorerUrl } from '@/config/network'
import styles from './ObserveEventLog.module.css'

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/

/** Every 0x… address appearing in an event's args (across all event types). */
function eventAddresses(event: CrowdfundEvent): string[] {
  return Object.values(event.args).filter(
    (v): v is string => typeof v === 'string' && ADDRESS_RE.test(v),
  )
}

type EventCategory = 'success' | 'info' | 'lavender' | 'error' | 'warning'

const EVENT_CATEGORY: Record<CrowdfundEventType, EventCategory> = {
  ArmLoaded: 'success',
  SeedAdded: 'info',
  Invited: 'info',
  LaunchTeamInvited: 'info',
  Committed: 'lavender',
  Finalized: 'success',
  Cancelled: 'error',
  Allocated: 'success',
  AllocatedHop: 'success',
  RefundClaimed: 'warning',
  InviteNonceRevoked: 'warning',
  UnallocatedArmWithdrawn: 'warning',
}

const CATEGORY_CLASS: Record<EventCategory, string> = {
  success: styles.catSuccess,
  info: styles.catInfo,
  lavender: styles.catLavender,
  error: styles.catError,
  warning: styles.catWarning,
}

const ALL_EVENT_TYPES = Object.keys(EVENT_CATEGORY) as CrowdfundEventType[]

const PAGE_SIZE = 200

function formatEventData(event: CrowdfundEvent, name: (addr: string) => string): string {
  const { args } = event
  switch (event.type) {
    case 'SeedAdded':
      return name(args.seed as string)
    case 'Invited':
      return `${name(args.inviter as string)} → ${name(args.invitee as string)} · hop-${args.hop}`
    case 'LaunchTeamInvited':
      return `LT → ${name(args.invitee as string)} · hop-${args.hop}`
    case 'Committed':
      return `${name(args.participant as string)} · ${formatUsdc(args.amount as bigint)} · hop-${args.hop}`
    case 'Finalized':
      return `size ${formatUsdc(args.saleSize as bigint)} · refund ${args.refundMode ? 'yes' : 'no'}`
    case 'Allocated':
      return `${name(args.participant as string)} · ${formatArm(args.armTransferred as bigint)}`
    case 'AllocatedHop':
      return `${name(args.participant as string)} · hop-${args.hop} · ${formatUsdc(args.acceptedUsdc as bigint)}`
    case 'RefundClaimed':
      return `${name(args.participant as string)} · ${formatUsdc(args.usdcAmount as bigint)}`
    case 'InviteNonceRevoked':
      return `${name(args.inviter as string)} · nonce ${String(args.nonce)}`
    case 'UnallocatedArmWithdrawn':
      return `${name(args.treasury as string)} · ${formatArm(args.amount as bigint)}`
    default:
      return ''
  }
}

export interface ObserveEventLogProps {
  events: CrowdfundEvent[]
  loading: boolean
  provider: JsonRpcProvider | null
}

export function ObserveEventLog({ events, loading, provider }: ObserveEventLogProps) {
  const [typeFilter, setTypeFilter] = useState<Set<CrowdfundEventType>>(new Set(ALL_EVENT_TYPES))
  const [search, setSearch] = useState('')
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  const explorerUrl = getExplorerUrl()

  // Resolve ENS for every address across all events (react-query dedupes against
  // the app's other ENS subscribers). `nameOf()` falls back to a truncated 0x….
  const addresses = useMemo(() => {
    const set = new Set<string>()
    for (const e of events) for (const a of eventAddresses(e)) set.add(a)
    return Array.from(set)
  }, [events])
  const { resolve } = useENS({ provider, addresses })
  const nameOf = (addr: string) => resolve(addr) ?? truncateAddress(addr)

  // Newest first. `events` arrives oldest→newest from the indexer, so reverse.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    const out = events.filter((e) => {
      if (!typeFilter.has(e.type)) return false
      if (q) {
        // Match the event's addresses (hex) or their resolved ENS names. (Don't
        // JSON.stringify args — they contain BigInt amounts, which throws.)
        const addrs = eventAddresses(e)
        const matches =
          addrs.some((a) => a.toLowerCase().includes(q)) ||
          addrs.some((a) => resolve(a)?.toLowerCase().includes(q) ?? false)
        if (!matches) return false
      }
      return true
    })
    out.reverse()
    return out
  }, [events, typeFilter, search, resolve])

  const toggleType = (type: CrowdfundEventType) => {
    setTypeFilter((prev) => {
      const next = new Set(prev)
      if (next.has(type)) next.delete(type)
      else next.add(type)
      return next
    })
  }

  return (
    <div className={styles.card}>
      <div className={styles.header}>
        <span className={styles.title}>Event log</span>
        <span className={styles.count}>
          {filtered.length} events{loading ? ' · syncing…' : ''}
        </span>
      </div>

      <div className={styles.controls}>
        <span className={styles.filterLabel}>Filter by type · click to toggle</span>
        <div className={styles.pills}>
          {ALL_EVENT_TYPES.map((type) => {
            const active = typeFilter.has(type)
            return (
              <button
                key={type}
                type="button"
                className={[styles.pill, active ? CATEGORY_CLASS[EVENT_CATEGORY[type]] : styles.pillOff]
                  .filter(Boolean)
                  .join(' ')}
                aria-pressed={active}
                onClick={() => toggleType(type)}
              >
                {type}
              </button>
            )
          })}
        </div>
        <input
          type="text"
          className={styles.search}
          placeholder="Filter by address…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          aria-label="Filter events by address"
        />
      </div>

      <div className={styles.listShell}>
        <div className={styles.listScroll}>
          {filtered.length === 0 ? (
            <div className={styles.empty}>No events</div>
          ) : (
            filtered.slice(0, visibleCount).map((event, i) => (
              <div key={`${event.transactionHash}-${event.logIndex}-${i}`} className={styles.row}>
                <span className={[styles.badge, CATEGORY_CLASS[EVENT_CATEGORY[event.type]]].join(' ')}>
                  {event.type}
                </span>
                <span className={styles.block}>#{event.blockNumber}</span>
                <span className={styles.data}>{formatEventData(event, nameOf)}</span>
                {explorerUrl ? (
                  <a
                    className={styles.tx}
                    href={`${explorerUrl}/tx/${event.transactionHash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {event.transactionHash.slice(0, 8)}…
                  </a>
                ) : (
                  <span className={styles.txPlain}>{event.transactionHash.slice(0, 8)}…</span>
                )}
              </div>
            ))
          )}
          {filtered.length > visibleCount && (
            <button
              type="button"
              className={styles.loadMore}
              onClick={() => setVisibleCount((prev) => prev + PAGE_SIZE)}
            >
              Load more ({filtered.length - visibleCount} remaining)
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
