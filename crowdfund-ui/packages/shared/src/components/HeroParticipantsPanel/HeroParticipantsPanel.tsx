// ABOUTME: Hero participants list + controls for CrowdfundLeftColumn (sequenced Show address).
// ABOUTME: Keeps POC extras: ENS displayName, multiHop filter, onParticipate, own-wallet row cue.

import { MagnifyingGlassIcon } from '@heroicons/react/24/outline'
import { useMemo, useState } from 'react'
import { Button } from '@armada/ui'
import { useCrowdfundListAnimation } from '../CrowdfundLeftColumn/index.js'
import { heroListHopColor } from '../../lib/graphHopColors.js'
import styles from './HeroParticipantsPanel.module.css'

export type HeroHopFilter = 'all' | 'seed' | 'hop1' | 'hop2' | 'multi'

export type HeroParticipant = {
  address: string
  /** Reverse-resolved ENS name for `address`. Renders in place of the
   *  truncated address when present; search and selection still key off
   *  the raw `address`. */
  displayName?: string
  hop: 'HOP-0' | 'HOP-1' | 'HOP-2'
  amountUsd: number
  // Phase 4b — multi-hop is now its own flag rather than a hop value. A wallet
  // with entries at multiple hops carries `multiHop: true` on its primary-hop
  // row; renderers detect multi-hop via this boolean.
  /** Direct inviter address: 'Armada' for launch-team / seed, the wallet's
   *  own address for self-invites, otherwise another participant's address. */
  inviter?: string
  /** True on every entry of a wallet that has entries at more than one hop. */
  multiHop?: boolean
  invitesTotal?: number
  invitesUsed?: number
  /** Marks the row representing the connected wallet — gets a lavender row hover. */
  isSelf?: boolean
}

const FILTERS: Array<{ id: HeroHopFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'seed', label: 'Hop-0' },
  { id: 'hop1', label: 'Hop 1' },
  { id: 'hop2', label: 'Hop 2' },
  { id: 'multi', label: 'Multi' },
]

function formatUsd(n: number) {
  return `$${Math.round(n).toLocaleString()}`
}

function hopColor(p: HeroParticipant) {
  // Multi-hop takes priority — green status accent. Otherwise the dot color
  // reflects the wallet's primary (lowest) hop, sourced from the same canonical
  // map the NodeSphere uses so the list dots match the sphere dots.
  if (p.multiHop) return heroListHopColor('MULTI-HOP')
  return heroListHopColor(p.hop)
}

/** Hop filter tab row — shared between the desktop controls row and the mobile
 *  stack. `className` lets the mobile stack stretch it full-width. */
function HopFilterBar({
  filter,
  onFilterChange,
  className,
}: {
  filter: HeroHopFilter
  onFilterChange: (filter: HeroHopFilter) => void
  className?: string
}) {
  return (
    <div
      className={[styles.filters, className].filter(Boolean).join(' ')}
      role="tablist"
      aria-label="Hop filters"
    >
      {FILTERS.map((f) => (
        <button
          key={f.id}
          type="button"
          className={[styles.filterBtn, filter === f.id && styles.filterBtnActive].filter(Boolean).join(' ')}
          onClick={() => onFilterChange(f.id)}
          role="tab"
          aria-selected={filter === f.id}
        >
          {f.label}
        </button>
      ))}
    </div>
  )
}

function filterRows(
  participants: HeroParticipant[],
  query: string,
  filter: HeroHopFilter,
): HeroParticipant[] {
  const q = query.trim().toLowerCase()
  return participants.filter((p) => {
    const matchesQuery =
      !q ||
      p.address.toLowerCase().includes(q) ||
      (p.displayName?.toLowerCase().includes(q) ?? false)
    const matchesFilter =
      filter === 'all' ||
      (filter === 'seed' && p.hop === 'HOP-0') ||
      (filter === 'hop1' && p.hop === 'HOP-1') ||
      (filter === 'hop2' && p.hop === 'HOP-2') ||
      (filter === 'multi' && !!p.multiHop)
    return matchesQuery && matchesFilter
  })
}

export interface HeroParticipantListProps {
  participants: HeroParticipant[]
  selectedAddress?: string
  onSelectAddress?: (address: string | undefined) => void
  filter?: HeroHopFilter
  /** Fires when the empty-state "Participate" CTA is clicked. */
  onParticipate?: () => void
}

export function HeroParticipantList({
  participants,
  selectedAddress,
  onSelectAddress,
  filter = 'all',
  onParticipate,
}: HeroParticipantListProps) {
  const { listOpen, listContentVisible } = useCrowdfundListAnimation()
  const [query, setQuery] = useState('')

  const rows = useMemo(
    () => filterRows(participants, query, filter),
    [participants, query, filter],
  )

  const isEmpty = participants.length === 0
  const noResults = !isEmpty && rows.length === 0
  // Collapsed: skip mounting thousands of DOM nodes while the list is hidden.
  const visibleRows = listOpen || listContentVisible ? rows : []

  return (
    <div className={styles.listHost} aria-hidden={!listOpen}>
      <div className={styles.listBackdrop}>
        <div
          className={[styles.listInner, listContentVisible && styles.listInnerReady]
            .filter(Boolean)
            .join(' ')}
        >
          <label className={styles.listSearch}>
            <MagnifyingGlassIcon className={styles.listSearchIcon} width={14} height={14} aria-hidden />
            <input
              className={styles.listSearchInput}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search participant address…"
              inputMode="search"
              autoComplete="off"
              aria-label="Search participant address"
              tabIndex={listOpen && listContentVisible ? 0 : -1}
            />
          </label>

          <div className={styles.listScroll}>
            {isEmpty ? (
              <div className={styles.empty}>
                <div className={styles.emptyTitle}>No participants yet</div>
                <div className={styles.emptySub}>Be the first to participate.</div>
                <div className={styles.emptyCta}>
                  <Button
                    variant="gradient"
                    size="md"
                    label="Participate"
                    showIcon
                    icon="arrow-right-micro"
                    onClick={onParticipate}
                  />
                </div>
              </div>
            ) : noResults ? (
              <div className={styles.empty}>
                <div className={styles.emptyTitle}>No matches</div>
                <div className={styles.emptySub}>Try a different address or filter.</div>
              </div>
            ) : (
              visibleRows.map((p, idx) => {
                const selected = p.address === selectedAddress
                return (
                  <button
                    key={p.address}
                    type="button"
                    className={[
                      styles.row,
                      selected && styles.rowSelected,
                      p.isSelf && styles.rowSelf,
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    onClick={() => onSelectAddress?.(selected ? undefined : p.address)}
                    aria-pressed={selected}
                    tabIndex={listOpen && listContentVisible ? 0 : -1}
                  >
                    <span className={styles.rank}>{idx + 1}</span>
                    <span className={styles.addr}>{p.displayName ?? p.address}</span>
                    <span className={styles.hop}>
                      <span className={styles.dot} style={{ ['--dot' as string]: hopColor(p) }} aria-hidden />
                      {p.hop}
                    </span>
                    <span className={styles.amount}>{formatUsd(p.amountUsd)}</span>
                  </button>
                )
              })
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export interface HeroParticipantControlsProps {
  filter?: HeroHopFilter
  onFilterChange?: (filter: HeroHopFilter) => void
}

export function HeroParticipantControls({
  filter: controlledFilter,
  onFilterChange,
}: HeroParticipantControlsProps) {
  const { listOpen, requestOpen, requestClose } = useCrowdfundListAnimation()
  const [uncontrolledFilter, setUncontrolledFilter] = useState<HeroHopFilter>('all')
  const filter = controlledFilter ?? uncontrolledFilter

  const setFilter = (next: HeroHopFilter) => {
    if (controlledFilter == null) setUncontrolledFilter(next)
    onFilterChange?.(next)
  }

  return (
    <div className={styles.controlsRow}>
      <HopFilterBar filter={filter} onFilterChange={setFilter} />

      <button
        type="button"
        className={styles.toggleBtn}
        onClick={() => {
          if (listOpen) requestClose()
          else requestOpen()
        }}
        aria-expanded={listOpen}
        aria-label={listOpen ? 'Hide participant addresses' : 'Show participant addresses'}
      >
        {listOpen ? 'Hide address' : 'Show address'}
      </button>
    </div>
  )
}

export interface HeroParticipantsMobileStackProps {
  participants: HeroParticipant[]
  selectedAddress?: string
  onSelectAddress?: (address: string | undefined) => void
  filter?: HeroHopFilter
  onFilterChange?: (filter: HeroHopFilter) => void
}

/** Mobile crowdfund — full-width filters + searchable participant list stacked
 *  below the graph. Replaces the desktop list/controls on mobile (which
 *  CrowdfundExperience hides at ≤767px). Renders ENS `displayName` in place of
 *  the raw address, matching the desktop panel. */
export function HeroParticipantsMobileStack({
  participants,
  selectedAddress,
  onSelectAddress,
  filter: controlledFilter,
  onFilterChange,
}: HeroParticipantsMobileStackProps) {
  const [uncontrolledFilter, setUncontrolledFilter] = useState<HeroHopFilter>('all')
  const [query, setQuery] = useState('')
  const filter = controlledFilter ?? uncontrolledFilter

  const setFilter = (next: HeroHopFilter) => {
    if (controlledFilter == null) setUncontrolledFilter(next)
    onFilterChange?.(next)
  }

  const rows = useMemo(
    () => filterRows(participants, query, filter),
    [participants, query, filter],
  )

  const isEmpty = participants.length === 0
  const noResults = !isEmpty && rows.length === 0

  return (
    <div className={styles.mobileStack}>
      <HopFilterBar
        filter={filter}
        onFilterChange={setFilter}
        className={styles.filtersFullWidth}
      />

      <div className={styles.mobileListCard}>
        <label className={styles.listSearch}>
          <MagnifyingGlassIcon className={styles.listSearchIcon} width={14} height={14} aria-hidden />
          <input
            className={styles.listSearchInput}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search participant address…"
            inputMode="search"
            autoComplete="off"
            aria-label="Search participant address"
          />
        </label>

        <div className={styles.mobileListScroll}>
          {isEmpty ? (
            <div className={styles.empty}>
              <div className={styles.emptyTitle}>No participants yet</div>
              <div className={styles.emptySub}>Be the first to participate.</div>
            </div>
          ) : noResults ? (
            <div className={styles.empty}>
              <div className={styles.emptyTitle}>No matches</div>
              <div className={styles.emptySub}>Try a different address or filter.</div>
            </div>
          ) : (
            rows.map((p, idx) => {
              const selected = p.address === selectedAddress
              return (
                <button
                  key={p.address}
                  type="button"
                  className={[
                    styles.row,
                    styles.mobileRow,
                    selected && styles.rowSelected,
                    p.isSelf && styles.rowSelf,
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  onClick={() => onSelectAddress?.(selected ? undefined : p.address)}
                  aria-pressed={selected}
                >
                  <span className={styles.rank}>{idx + 1}</span>
                  <span className={styles.addr}>{p.displayName ?? p.address}</span>
                  <span className={styles.hop}>
                    <span className={styles.dot} style={{ ['--dot' as string]: hopColor(p) }} aria-hidden />
                    {p.hop}
                  </span>
                  <span className={styles.amount}>{formatUsd(p.amountUsd)}</span>
                </button>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}
