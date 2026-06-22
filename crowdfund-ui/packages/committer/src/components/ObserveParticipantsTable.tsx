// ABOUTME: Observe-page participants table — committer-styled adaptation of the admin ParticipantTable.
// ABOUTME: Plain-React (no react-table): per-hop / per-address views, hop/status/claim filters, address search, click-to-sort, ENS names, phase-conditional ARM/Refund/Claimed columns. Styled like the hop table.

import { useMemo, useState, type ReactNode } from 'react'
import type { JsonRpcProvider } from 'ethers'
import {
  formatUsdc,
  formatArm,
  truncateAddress,
  hopLabel,
  heroListHopColor,
  useENS,
  type CrowdfundEvent,
} from '@armada/crowdfund-shared'
import { useParticipants, type ParticipantRow } from '@/hooks/useParticipants'
import styles from './ObserveParticipantsTable.module.css'

type ViewMode = 'per-hop' | 'per-address'
type NameFn = (addr: string) => string
type SortState = { key: string; desc: boolean }

interface AggregatedRow {
  address: string
  hops: number[]
  totalCommitted: bigint
  totalCap: bigint
  totalInvitesUsed: number
  totalInvitesTotal: number
  allocatedArm: bigint | null
  refundUsdc: bigint | null
  armClaimed: boolean
  refundClaimed: boolean
}

interface Column<T> {
  key: string
  header: string
  align?: 'left' | 'right'
  sortValue?: (row: T) => bigint | number | string
  render: (row: T, name: NameFn) => ReactNode
}

const HOP_DOT = (hop: number) => heroListHopColor(hop === 0 ? 'SEED' : hop === 1 ? 'HOP-1' : 'HOP-2')

function compare(a: bigint | number | string, b: bigint | number | string): number {
  if (typeof a === 'bigint' && typeof b === 'bigint') return a < b ? -1 : a > b ? 1 : 0
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a).localeCompare(String(b))
}

function claimCell(armClaimed: boolean, refundUsdc: bigint | null, refundClaimed: boolean): ReactNode {
  return (
    <span className={styles.claimGroup}>
      ARM <span className={armClaimed ? styles.claimOk : styles.claimNo}>{armClaimed ? '✓' : '✗'}</span>
      {refundUsdc !== null && refundUsdc > 0n && (
        <>
          {' '}
          · Refund{' '}
          <span className={refundClaimed ? styles.claimOk : styles.claimNo}>
            {refundClaimed ? '✓' : '✗'}
          </span>
        </>
      )}
    </span>
  )
}

function addrCell(address: string, name: NameFn): ReactNode {
  return <span className={styles.addrCell}>{name(address)}</span>
}

function hopCell(hop: number): ReactNode {
  return (
    <span className={styles.hopCell}>
      <span className={styles.dot} style={{ background: HOP_DOT(hop) }} aria-hidden />
      {hopLabel(hop)}
    </span>
  )
}

export interface ObserveParticipantsTableProps {
  events: CrowdfundEvent[]
  phase: number
  provider: JsonRpcProvider | null
}

export function ObserveParticipantsTable({ events, phase, provider }: ObserveParticipantsTableProps) {
  const rows = useParticipants(events)

  const [viewMode, setViewMode] = useState<ViewMode>('per-hop')
  const [hopFilter, setHopFilter] = useState<number | null>(null)
  const [statusFilter, setStatusFilter] = useState<'all' | 'committed' | 'invited'>('all')
  const [claimFilter, setClaimFilter] = useState<'all' | 'claimed' | 'unclaimed'>('all')
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<SortState>({ key: 'committed', desc: true })

  // Resolve ENS for every participant address (react-query dedupes against the
  // app's other ENS subscribers). `name()` falls back to a truncated address.
  const addresses = useMemo(() => rows.map((r) => r.address), [rows])
  const { resolve } = useENS({ provider, addresses })
  const name: NameFn = (addr) => resolve(addr) ?? truncateAddress(addr)

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return rows.filter((p) => {
      if (hopFilter !== null && p.hop !== hopFilter) return false
      if (statusFilter === 'committed' && p.committed === 0n) return false
      if (statusFilter === 'invited' && p.committed > 0n) return false
      if (claimFilter === 'claimed' && !p.armClaimed) return false
      if (claimFilter === 'unclaimed' && p.armClaimed) return false
      if (q) {
        const ens = resolve(p.address)
        if (!p.address.toLowerCase().includes(q) && !(ens?.toLowerCase().includes(q) ?? false))
          return false
      }
      return true
    })
  }, [rows, hopFilter, statusFilter, claimFilter, search, resolve])

  const aggregated = useMemo((): AggregatedRow[] => {
    if (viewMode !== 'per-address') return []
    const groups = new Map<string, ParticipantRow[]>()
    for (const p of filtered) {
      const existing = groups.get(p.address)
      if (existing) existing.push(p)
      else groups.set(p.address, [p])
    }
    return Array.from(groups.entries()).map(([address, group]) => ({
      address,
      hops: group.map((r) => r.hop),
      totalCommitted: group.reduce((s, r) => s + r.committed, 0n),
      totalCap: group.reduce((s, r) => s + r.effectiveCap, 0n),
      totalInvitesUsed: group.reduce((s, r) => s + r.invitesUsed, 0),
      totalInvitesTotal: group.reduce((s, r) => s + r.invitesTotal, 0),
      allocatedArm: group.some((r) => r.allocatedArm !== null)
        ? group.reduce((s, r) => s + (r.allocatedArm ?? 0n), 0n)
        : null,
      refundUsdc: group.some((r) => r.refundUsdc !== null)
        ? group.reduce((s, r) => s + (r.refundUsdc ?? 0n), 0n)
        : null,
      armClaimed: group.some((r) => r.armClaimed),
      refundClaimed: group.some((r) => r.refundClaimed),
    }))
  }, [filtered, viewMode])

  const perHopColumns: Column<ParticipantRow>[] = useMemo(() => {
    const cols: Column<ParticipantRow>[] = [
      { key: 'address', header: 'Address', align: 'left', sortValue: (r) => r.address, render: (r, n) => addrCell(r.address, n) },
      { key: 'hop', header: 'Hop', align: 'left', sortValue: (r) => r.hop, render: (r) => hopCell(r.hop) },
      { key: 'invitedBy', header: 'Invited by', align: 'left', render: (r, n) => {
        if (r.invitedBy.length === 0) return '—'
        const inv = r.invitedBy[0]
        return inv.toLowerCase() === 'armada' ? <span className={styles.armada}>Armada</span> : n(inv)
      } },
      { key: 'committed', header: 'Committed', align: 'right', sortValue: (r) => r.committed, render: (r) => formatUsdc(r.committed) },
      { key: 'effectiveCap', header: 'Cap', align: 'right', sortValue: (r) => r.effectiveCap, render: (r) => formatUsdc(r.effectiveCap) },
      { key: 'invites', header: 'Invites', align: 'right', sortValue: (r) => r.invitesUsed, render: (r) => `${r.invitesUsed} / ${r.invitesTotal}` },
    ]
    if (phase >= 1) {
      cols.push(
        { key: 'allocatedArm', header: 'ARM alloc', align: 'right', sortValue: (r) => r.allocatedArm ?? 0n, render: (r) => (r.allocatedArm !== null ? formatArm(r.allocatedArm) : '—') },
        { key: 'refundUsdc', header: 'Refund', align: 'right', render: (r) => (r.refundUsdc !== null && r.refundUsdc > 0n ? formatUsdc(r.refundUsdc) : '—') },
        { key: 'claimed', header: 'Claimed', align: 'right', render: (r) => (r.allocatedArm === null ? '—' : claimCell(r.armClaimed, r.refundUsdc, r.refundClaimed)) },
      )
    }
    return cols
  }, [phase])

  const aggColumns: Column<AggregatedRow>[] = useMemo(() => {
    const cols: Column<AggregatedRow>[] = [
      { key: 'address', header: 'Address', align: 'left', sortValue: (r) => r.address, render: (r, n) => addrCell(r.address, n) },
      { key: 'hops', header: 'Hops', align: 'left', render: (r) => r.hops.map((h) => `H${h}`).join(', ') },
      { key: 'committed', header: 'Committed', align: 'right', sortValue: (r) => r.totalCommitted, render: (r) => formatUsdc(r.totalCommitted) },
      { key: 'totalCap', header: 'Cap', align: 'right', sortValue: (r) => r.totalCap, render: (r) => formatUsdc(r.totalCap) },
      { key: 'invites', header: 'Invites', align: 'right', sortValue: (r) => r.totalInvitesUsed, render: (r) => `${r.totalInvitesUsed} / ${r.totalInvitesTotal}` },
    ]
    if (phase >= 1) {
      cols.push(
        { key: 'allocatedArm', header: 'ARM alloc', align: 'right', sortValue: (r) => r.allocatedArm ?? 0n, render: (r) => (r.allocatedArm !== null ? formatArm(r.allocatedArm) : '—') },
        { key: 'claimed', header: 'Claimed', align: 'right', render: (r) => (r.allocatedArm === null ? '—' : claimCell(r.armClaimed, r.refundUsdc, r.refundClaimed)) },
      )
    }
    return cols
  }, [phase])

  const toggleSort = (key: string) => {
    setSort((prev) => (prev.key === key ? { key, desc: !prev.desc } : { key, desc: true }))
  }

  function sortRows<T>(data: T[], columns: Column<T>[]): T[] {
    const col = columns.find((c) => c.key === sort.key && c.sortValue)
    if (!col || !col.sortValue) return data
    const get = col.sortValue
    return [...data].sort((a, b) => {
      const r = compare(get(a), get(b))
      return sort.desc ? -r : r
    })
  }

  const dataCount = viewMode === 'per-hop' ? filtered.length : aggregated.length

  function TableBlock<T>({ columns, data }: { columns: Column<T>[]; data: T[] }) {
    return (
      <table className={styles.table}>
        <thead>
          <tr>
            {columns.map((c) => {
              const sortable = !!c.sortValue
              const active = sort.key === c.key
              return (
                <th
                  key={c.key}
                  data-align={c.align ?? 'right'}
                  className={sortable ? styles.sortable : undefined}
                  onClick={sortable ? () => toggleSort(c.key) : undefined}
                  aria-sort={active ? (sort.desc ? 'descending' : 'ascending') : undefined}
                >
                  {c.header}
                  {sortable && active ? (sort.desc ? ' ↓' : ' ↑') : ''}
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody>
          {data.map((row, i) => (
            <tr key={i}>
              {columns.map((c) => (
                <td key={c.key} data-align={c.align ?? 'right'}>
                  {c.render(row, name)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    )
  }

  return (
    <div className={styles.card}>
      <div className={styles.header}>
        <span className={styles.title}>Participants</span>
        <span className={styles.count}>{dataCount} entries</span>
      </div>

      <div className={styles.controls}>
        <div className={styles.viewToggle} role="group" aria-label="View mode">
          <button
            type="button"
            className={[styles.segBtn, viewMode === 'per-hop' && styles.segBtnActive].filter(Boolean).join(' ')}
            onClick={() => {
              setViewMode('per-hop')
              setSort({ key: 'committed', desc: true })
            }}
          >
            Per hop
          </button>
          <button
            type="button"
            className={[styles.segBtn, viewMode === 'per-address' && styles.segBtnActive].filter(Boolean).join(' ')}
            onClick={() => {
              setViewMode('per-address')
              setSort({ key: 'committed', desc: true })
            }}
          >
            Per address
          </button>
        </div>

        <select
          className={styles.select}
          value={hopFilter ?? 'all'}
          onChange={(e) => setHopFilter(e.target.value === 'all' ? null : Number(e.target.value))}
          aria-label="Hop filter"
        >
          <option value="all">All hops</option>
          <option value="0">Seed (hop-0)</option>
          <option value="1">Hop-1</option>
          <option value="2">Hop-2</option>
        </select>

        <select
          className={styles.select}
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as 'all' | 'committed' | 'invited')}
          aria-label="Status filter"
        >
          <option value="all">All status</option>
          <option value="committed">Committed</option>
          <option value="invited">Invited only</option>
        </select>

        {phase >= 1 && (
          <select
            className={styles.select}
            value={claimFilter}
            onChange={(e) => setClaimFilter(e.target.value as 'all' | 'claimed' | 'unclaimed')}
            aria-label="Claim filter"
          >
            <option value="all">All claims</option>
            <option value="claimed">Claimed</option>
            <option value="unclaimed">Unclaimed</option>
          </select>
        )}

        <input
          type="text"
          className={styles.search}
          placeholder="Search address or ENS…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          aria-label="Search participants"
        />
      </div>

      <div className={styles.tableShell}>
        <div className={styles.tableScroll}>
          {viewMode === 'per-hop' ? (
            <TableBlock columns={perHopColumns} data={sortRows(filtered, perHopColumns)} />
          ) : (
            <TableBlock columns={aggColumns} data={sortRows(aggregated, aggColumns)} />
          )}
          {dataCount === 0 && <div className={styles.empty}>No participants</div>}
        </div>
      </div>
    </div>
  )
}
