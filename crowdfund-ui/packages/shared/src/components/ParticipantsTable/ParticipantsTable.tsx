// ABOUTME: Sortable/searchable participant table for the crowdfund — address, hop, committed, invites used/total.
// ABOUTME: Ported byte-identical from the armada-crowdfund mockup; `../Button` import rewritten to `@armada/ui`.

import { MagnifyingGlassIcon } from '@heroicons/react/24/outline'
import { useMemo, useState } from 'react'
import { Button } from '@armada/ui'
import styles from './ParticipantsTable.module.css'

export type ParticipantsTableFilter = 'all' | 'hop0' | 'hop1' | 'hop2' | 'multi'

export interface ParticipantsTableProps {
  filter?: ParticipantsTableFilter
  onFilterChange?: (next: ParticipantsTableFilter) => void
  query?: string
  onQueryChange?: (next: string) => void
  rows?: ParticipantRow[]
}

export type ParticipantRow = {
  address: string
  hops: string
  committedUsd: number
  invitedBy: string
  invitesUsed: number
  invitesTotal: number
  /** True when this wallet has entries at more than one hop. Drives the 'multi' filter. */
  multiHop?: boolean
}

const FILTERS: Array<{ id: ParticipantsTableFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'hop0', label: 'Seed' },
  { id: 'hop1', label: 'Hop 1' },
  { id: 'hop2', label: 'Hop 2' },
  { id: 'multi', label: 'Multi-hop' },
]

const MOCK_ROWS: ParticipantRow[] = [
  {
    address: '0x63c2...84c6',
    hops: 'Hop 0',
    committedUsd: 40,
    invitedBy: 'Armada',
    invitesUsed: 0,
    invitesTotal: 3,
  },
  {
    address: '0xef03...dc52',
    hops: 'Hop 0',
    committedUsd: 20,
    invitedBy: 'Armada',
    invitesUsed: 2,
    invitesTotal: 3,
  },
  {
    address: '0x9a1d...f0b2',
    hops: 'Hop 1',
    committedUsd: 120,
    invitedBy: '0x63c2...84c6',
    invitesUsed: 1,
    invitesTotal: 3,
  },
  {
    address: '0x2d8b...19aa',
    hops: 'Hop 2',
    committedUsd: 75,
    invitedBy: '0xef03...dc52',
    invitesUsed: 3,
    invitesTotal: 3,
  },
  {
    address: '0x7c44...0e18',
    hops: 'Hop 1',
    committedUsd: 250,
    invitedBy: 'Armada',
    invitesUsed: 0,
    invitesTotal: 3,
  },
  {
    address: '0x4f91...a3d0',
    hops: 'Hop 0',
    committedUsd: 10,
    invitedBy: 'Armada',
    invitesUsed: 0,
    invitesTotal: 3,
  },
  {
    address: '0xb12e...c9f1',
    hops: 'Multi-hop',
    committedUsd: 500,
    invitedBy: '0x9a1d...f0b2',
    invitesUsed: 2,
    invitesTotal: 5,
  },
  {
    address: '0x0ad7...3b6e',
    hops: 'Hop 2',
    committedUsd: 30,
    invitedBy: '0x7c44...0e18',
    invitesUsed: 1,
    invitesTotal: 3,
  },
  {
    address: '0x5e66...91c4',
    hops: 'Hop 1',
    committedUsd: 60,
    invitedBy: '0xef03...dc52',
    invitesUsed: 1,
    invitesTotal: 3,
  },
  {
    address: '0x3b20...77ad',
    hops: 'Hop 0',
    committedUsd: 90,
    invitedBy: 'Armada',
    invitesUsed: 2,
    invitesTotal: 3,
  },
  {
    address: '0xdd02...5c10',
    hops: 'Multi-hop',
    committedUsd: 180,
    invitedBy: '0x2d8b...19aa',
    invitesUsed: 1,
    invitesTotal: 5,
  },
  {
    address: '0x1c8f...8e2b',
    hops: 'Hop 2',
    committedUsd: 15,
    invitedBy: '0x5e66...91c4',
    invitesUsed: 0,
    invitesTotal: 3,
  },
  {
    address: '0xa77e...2d44',
    hops: 'Hop 1',
    committedUsd: 300,
    invitedBy: 'Armada',
    invitesUsed: 3,
    invitesTotal: 3,
  },
]

function formatUsd(n: number) {
  const v = Math.round(n)
  return `$${v.toLocaleString()}`
}

function addressSeed(addr: string) {
  let h = 0
  for (let i = 0; i < addr.length; i++) h = (h * 31 + addr.charCodeAt(i)) >>> 0
  return h
}

function seedToColor(seed: number) {
  const palette = [
    'var(--semantic-color-brand-lavender)',
    'var(--semantic-color-brand-amber)',
    'rgba(52,211,153,0.9)', // success green (matches ACTIVE dot feel)
    'rgba(96,165,250,0.9)', // info blue
  ]
  return palette[seed % palette.length]
}

export function ParticipantsTable({
  filter: filterProp,
  onFilterChange,
  query: queryProp,
  onQueryChange,
  rows: rowsProp,
}: ParticipantsTableProps) {
  const [queryState, setQueryState] = useState('')
  const [filterState, setFilterState] = useState<ParticipantsTableFilter>('all')

  const query = queryProp ?? queryState
  const filter = filterProp ?? filterState

  const setQuery = onQueryChange ?? setQueryState
  const setFilter = onFilterChange ?? setFilterState

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    const base = rowsProp ?? MOCK_ROWS
    return base.filter((r) => {
      const matchesQuery = !q || r.address.toLowerCase().includes(q)
      const matchesFilter =
        filter === 'all' ||
        (filter === 'hop0' && r.hops === 'Hop 0') ||
        (filter === 'hop1' && r.hops === 'Hop 1') ||
        (filter === 'hop2' && r.hops === 'Hop 2') ||
        (filter === 'multi' && !!r.multiHop)
      return matchesQuery && matchesFilter
    })
  }, [query, filter, rowsProp])

  const isScenarioEmpty = (rowsProp?.length ?? 0) === 0 && query.trim().length === 0 && filter === 'all'

  return (
    <section className={styles.section} aria-label="Participants">
      <div className={styles.headerRow}>
        <h2 className={styles.title}>Participants</h2>

        <div className={styles.controls}>
          <div className={styles.searchWrap}>
            <MagnifyingGlassIcon className={styles.searchIcon} width={14} height={14} aria-hidden />
            <input
              className={styles.search}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search address…"
              inputMode="search"
              aria-label="Search participants"
            />
          </div>

          <div className={styles.filters} role="tablist" aria-label="Hop filters">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                className={[styles.filterBtn, filter === f.id && styles.filterBtnActive].filter(Boolean).join(' ')}
                onClick={() => setFilter(f.id)}
                role="tab"
                aria-selected={filter === f.id}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className={styles.tableShell}>
        <div className={styles.table}>
          <div className={[styles.tr, styles.th].join(' ')}>
            <div className={styles.td}>Address</div>
            <div className={styles.td}>Hop(s)</div>
            <div className={[styles.td, styles.num].join(' ')}>Committed</div>
            <div className={styles.td}>Invited by</div>
            <div className={styles.td}>Invites (used / total)</div>
            <div className={[styles.td, styles.actions].join(' ')}>Actions</div>
          </div>

          {rows.map((r) => {
            const seed = addressSeed(r.address)
            const avatarColor = seedToColor(seed)
            const invitesPct =
              r.invitesTotal > 0 ? Math.min(1, Math.max(0, r.invitesUsed / r.invitesTotal)) : 0

            return (
              <div key={r.address} className={styles.tr}>
                <div className={styles.td}>
                  <div className={styles.addrCell}>
                    <span className={styles.avatar} style={{ ['--avatar' as any]: avatarColor }} aria-hidden />
                    <span className={styles.addr}>{r.address}</span>
                  </div>
                </div>
                <div className={styles.td}>
                  <span className={styles.hopPill}>{r.hops}</span>
                </div>
                <div className={[styles.td, styles.num].join(' ')}>
                  <div className={styles.committed}>
                    <div className={styles.committedTop}>{formatUsd(r.committedUsd)}</div>
                    <div className={styles.committedSub}>1/? committed</div>
                  </div>
                </div>
                <div className={styles.td}>{r.invitedBy}</div>
                <div className={styles.td}>
                  <div className={styles.invites}>
                    <div className={styles.invitesMeta}>
                      <span className={styles.invitesText}>
                        {r.invitesUsed}/{r.invitesTotal}
                      </span>
                    </div>
                    <div className={styles.invitesBar} aria-hidden>
                      <div className={styles.invitesFill} style={{ width: `${invitesPct * 100}%` }} />
                    </div>
                  </div>
                </div>
                <div className={[styles.td, styles.actions].join(' ')}>
                  <button type="button" className={styles.moreBtn} aria-label="Row actions">
                    …
                  </button>
                </div>
              </div>
            )
          })}

          {rows.length === 0 && (
            <div className={styles.empty}>
              {isScenarioEmpty ? (
                <>
                  <div className={styles.emptyTitle}>No participants yet</div>
                  <div className={styles.emptySub}>Be the first to participate.</div>
                  <div className={styles.emptyCta}>
                    <Button variant="gradient" size="md" label="Participate" showIcon icon="arrow-right-micro" />
                  </div>
                </>
              ) : (
                <>
                  <div className={styles.emptyTitle}>No matches</div>
                  <div className={styles.emptySub}>Try a different address or filter.</div>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  )
}
