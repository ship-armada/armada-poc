// ABOUTME: Hero-page participants panel — expandable list with search, hop filters, and Show/Hide toggle.
// ABOUTME: Ported byte-identical from the armada-crowdfund mockup; `../Button` import rewritten to `@armada/ui`.

import { MagnifyingGlassIcon } from '@heroicons/react/24/outline'
import { useMemo, useState } from 'react'
import { Button } from '@armada/ui'
import { heroListHopColor } from '../../lib/graphHopColors.js'
import styles from './HeroParticipantsPanel.module.css'

export type HeroHopFilter = 'all' | 'seed' | 'hop1' | 'hop2' | 'multi'

export type HeroParticipant = {
  address: string
  /** Reverse-resolved ENS name for `address`. Renders in place of the
   *  truncated address when present; search and selection still key off
   *  the raw `address`. */
  displayName?: string
  hop: 'SEED' | 'HOP-1' | 'HOP-2'
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
  { id: 'seed', label: 'Seed' },
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

export interface HeroParticipantsPanelProps {
  participants: HeroParticipant[]
  selectedAddress?: string
  onSelectAddress?: (address: string | undefined) => void
  collapsedMaxRows?: number
  filter?: HeroHopFilter
  onFilterChange?: (filter: HeroHopFilter) => void
  showList?: boolean
  onShowListChange?: (open: boolean) => void
  layoutExpanded?: boolean
  /** Fires when the empty-state "Participate" CTA is clicked. */
  onParticipate?: () => void
  /** When provided, renders a "Details" text button beside the Show/Hide toggle
   *  — used by the committer to open the Observe (cards + tables) view. */
  onDetails?: () => void
}

export function HeroParticipantsPanel({
  participants,
  selectedAddress,
  onSelectAddress,
  collapsedMaxRows = 3,
  filter: controlledFilter,
  onFilterChange,
  showList: controlledShowList,
  onShowListChange,
  layoutExpanded: layoutExpandedProp,
  onParticipate,
  onDetails,
}: HeroParticipantsPanelProps) {
  const [uncontrolledShowList, setUncontrolledShowList] = useState(false)
  const showList = controlledShowList ?? uncontrolledShowList
  const [query, setQuery] = useState('')
  const [uncontrolledFilter, setUncontrolledFilter] = useState<HeroHopFilter>('all')
  const filter = controlledFilter ?? uncontrolledFilter
  const layoutExpanded = layoutExpandedProp ?? showList

  const setShowList = (open: boolean) => {
    if (controlledShowList == null) setUncontrolledShowList(open)
    onShowListChange?.(open)
  }

  const setFilter = (next: HeroHopFilter) => {
    if (controlledFilter == null) setUncontrolledFilter(next)
    onFilterChange?.(next)
  }

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    return participants.filter((p) => {
      const matchesQuery =
        !q ||
        p.address.toLowerCase().includes(q) ||
        (p.displayName?.toLowerCase().includes(q) ?? false)
      const matchesFilter =
        filter === 'all' ||
        (filter === 'seed' && p.hop === 'SEED') ||
        (filter === 'hop1' && p.hop === 'HOP-1') ||
        (filter === 'hop2' && p.hop === 'HOP-2') ||
        (filter === 'multi' && !!p.multiHop)
      return matchesQuery && matchesFilter
    })
  }, [participants, query, filter])

  const isEmpty = participants.length === 0
  const noResults = !isEmpty && rows.length === 0
  // Collapsed: only mount a handful of rows (the list is hidden anyway), so we
  // don't reconcile thousands of DOM nodes every poll. Expanded: render all
  // (rows carry `content-visibility: auto` so off-screen rows skip layout).
  const visibleRows = showList ? rows : rows.slice(0, collapsedMaxRows)

  return (
    <section className={[styles.panel, layoutExpanded && styles.expanded].filter(Boolean).join(' ')} aria-label="Participants">
      <div
        className={[
          styles.listShell,
          layoutExpanded ? styles.listShellOpen : styles.listShellClosed,
          showList ? styles.listAnimOpen : styles.listAnimClosed,
        ].join(' ')}
        aria-hidden={!showList}
      >
        <div className={styles.listBackdrop}>
          <div
            className={[
              styles.listInner,
              showList ? styles.listInnerVisible : styles.listInnerHidden,
            ].join(' ')}
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
                tabIndex={showList ? 0 : -1}
              />
            </label>

            <div className={styles.listScroll}>
              {isEmpty ? (
                <div className={styles.empty}>
                  <div className={styles.emptyTitle}>No participants yet</div>
                  <div className={styles.emptySub}>Be the first to participate.</div>
                  <div className={styles.emptyCta}>
                    <Button variant="gradient" size="md" label="Participate" showIcon icon="arrow-right-micro" onClick={onParticipate} />
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
                      tabIndex={showList ? 0 : -1}
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

      <div className={styles.controlsRow}>
        <HopFilterBar filter={filter} onFilterChange={setFilter} />

        <button
          type="button"
          className={styles.toggleBtn}
          onClick={() => {
            setShowList(!showList)
          }}
          aria-expanded={showList}
        >
          {showList ? 'Hide address' : 'Show address'}
        </button>

        {onDetails && (
          <button type="button" className={styles.detailsBtn} onClick={onDetails}>
            Details
          </button>
        )}
      </div>
    </section>
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
 *  below the graph. Replaces the desktop `HeroParticipantsPanel` list/controls
 *  on mobile (which the CrowdfundExperience hides at ≤767px). Renders ENS
 *  `displayName` in place of the raw address, matching the desktop panel. */
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

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    return participants.filter((p) => {
      const matchesQuery =
        !q ||
        p.address.toLowerCase().includes(q) ||
        (p.displayName?.toLowerCase().includes(q) ?? false)
      const matchesFilter =
        filter === 'all' ||
        (filter === 'seed' && p.hop === 'SEED') ||
        (filter === 'hop1' && p.hop === 'HOP-1') ||
        (filter === 'hop2' && p.hop === 'HOP-2') ||
        (filter === 'multi' && !!p.multiHop)
      return matchesQuery && matchesFilter
    })
  }, [participants, query, filter])

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
