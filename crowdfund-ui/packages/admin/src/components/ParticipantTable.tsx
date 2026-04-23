// ABOUTME: Sortable, filterable participant table using @tanstack/react-table.
// ABOUTME: Per-hop and per-address views, dual claim indicators, and phase-conditional columns.

import { useState, useMemo } from 'react'
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  getExpandedRowModel,
  useReactTable,
  type SortingState,
  type ColumnDef,
  type Table as TanstackTable,
} from '@tanstack/react-table'
import {
  formatUsdc,
  formatArm,
  truncateAddress,
  hopLabel,
} from '@armada/crowdfund-shared'
import type { ParticipantRow } from '@/hooks/useParticipants'

export interface ParticipantTableProps {
  participants: ParticipantRow[]
  phase: number
  launchTeamAddress: string | null
}

// Per-address aggregated row for the aggregation toggle
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
  subRows: ParticipantRow[]
}

const perHopColumnHelper = createColumnHelper<ParticipantRow>()
const aggColumnHelper = createColumnHelper<AggregatedRow>()

export function ParticipantTable({ participants, phase, launchTeamAddress }: ParticipantTableProps) {
  const [sorting, setSorting] = useState<SortingState>([
    { id: 'committed', desc: true },
  ])
  const [hopFilter, setHopFilter] = useState<number | null>(null)
  const [statusFilter, setStatusFilter] = useState<'all' | 'committed' | 'invited'>('all')
  const [claimFilter, setClaimFilter] = useState<'all' | 'claimed' | 'unclaimed'>('all')
  const [search, setSearch] = useState('')
  const [viewMode, setViewMode] = useState<'per-hop' | 'per-address'>('per-hop')

  // Reset sorting to the correct column ID when switching view modes,
  // since per-hop uses 'committed' and per-address uses 'totalCommitted'.
  const setViewModeWithSort = (mode: 'per-hop' | 'per-address') => {
    setViewMode(mode)
    const commitCol = mode === 'per-hop' ? 'committed' : 'totalCommitted'
    setSorting([{ id: commitCol, desc: true }])
  }

  // Per-hop columns (default view)
  const perHopColumns: ColumnDef<ParticipantRow, any>[] = useMemo(() => {
    const cols: ColumnDef<ParticipantRow, any>[] = [
      perHopColumnHelper.accessor('address', {
        header: 'Address',
        cell: (info) => (
          <span className="font-mono">{truncateAddress(info.getValue())}</span>
        ),
      }),
      perHopColumnHelper.accessor('hop', {
        header: 'Hop',
        cell: (info) => hopLabel(info.getValue()),
      }),
      perHopColumnHelper.accessor('invitedBy', {
        header: 'Invited By',
        cell: (info) => {
          const val = info.getValue()
          if (val.length === 0) return '-'
          if (val[0] === 'armada') return <span className="text-info">Armada</span>
          if (launchTeamAddress && val[0].toLowerCase() === launchTeamAddress.toLowerCase()) {
            return <span className="text-success">Launch Team</span>
          }
          return <span className="font-mono">{truncateAddress(val[0])}</span>
        },
      }),
      perHopColumnHelper.accessor('committed', {
        header: 'Committed',
        cell: (info) => formatUsdc(info.getValue()),
        sortingFn: (a, b) => {
          const av = a.original.committed
          const bv = b.original.committed
          return av > bv ? 1 : av < bv ? -1 : 0
        },
      }),
      perHopColumnHelper.accessor('effectiveCap', {
        header: 'Cap',
        cell: (info) => formatUsdc(info.getValue()),
      }),
      perHopColumnHelper.accessor('invitesUsed', {
        header: 'Invites',
        cell: (info) => `${info.getValue()} / ${info.row.original.invitesTotal}`,
      }),
    ]

    if (phase >= 1) {
      cols.push(
        perHopColumnHelper.accessor('allocatedArm', {
          id: 'allocatedArm',
          header: 'ARM Allocated',
          cell: (info) => {
            const val = info.getValue()
            return val !== null ? formatArm(val as bigint) : '-'
          },
        }),
        perHopColumnHelper.accessor('refundUsdc', {
          id: 'refundUsdc',
          header: 'Refund',
          cell: (info) => {
            const val = info.getValue()
            return val !== null && (val as bigint) > 0n ? formatUsdc(val as bigint) : '-'
          },
        }),
        perHopColumnHelper.display({
          id: 'claimed',
          header: 'Claimed',
          cell: (info) => {
            const row = info.row.original
            if (row.allocatedArm === null) return '-'
            return (
              <span className="whitespace-nowrap">
                ARM {row.armClaimed ? '✓' : '✗'}
                {row.refundUsdc !== null && row.refundUsdc > 0n && (
                  <> Refund {row.refundClaimed ? '✓' : '✗'}</>
                )}
              </span>
            )
          },
        }),
      )
    }

    return cols
  }, [launchTeamAddress, phase])

  // Filter per-hop data
  const filtered = useMemo(() => {
    return participants.filter((p) => {
      if (hopFilter !== null && p.hop !== hopFilter) return false
      if (statusFilter === 'committed' && p.committed === 0n) return false
      if (statusFilter === 'invited' && p.committed > 0n) return false
      if (claimFilter === 'claimed' && !p.armClaimed) return false
      if (claimFilter === 'unclaimed' && p.armClaimed) return false
      if (search && !p.address.toLowerCase().includes(search.toLowerCase())) return false
      return true
    })
  }, [participants, hopFilter, statusFilter, claimFilter, search])

  // Per-address aggregation
  const aggregated = useMemo((): AggregatedRow[] => {
    if (viewMode !== 'per-address') return []

    const groups = new Map<string, ParticipantRow[]>()
    for (const p of filtered) {
      const existing = groups.get(p.address)
      if (existing) {
        existing.push(p)
      } else {
        groups.set(p.address, [p])
      }
    }

    return Array.from(groups.entries()).map(([address, rows]) => ({
      address,
      hops: rows.map((r) => r.hop),
      totalCommitted: rows.reduce((sum, r) => sum + r.committed, 0n),
      totalCap: rows.reduce((sum, r) => sum + r.effectiveCap, 0n),
      totalInvitesUsed: rows.reduce((sum, r) => sum + r.invitesUsed, 0),
      totalInvitesTotal: rows.reduce((sum, r) => sum + r.invitesTotal, 0),
      allocatedArm: rows.some((r) => r.allocatedArm !== null)
        ? rows.reduce((sum, r) => sum + (r.allocatedArm ?? 0n), 0n)
        : null,
      refundUsdc: rows.some((r) => r.refundUsdc !== null)
        ? rows.reduce((sum, r) => sum + (r.refundUsdc ?? 0n), 0n)
        : null,
      armClaimed: rows.some((r) => r.armClaimed),
      refundClaimed: rows.some((r) => r.refundClaimed),
      subRows: rows,
    })).sort((a, b) => (b.totalCommitted > a.totalCommitted ? 1 : b.totalCommitted < a.totalCommitted ? -1 : 0))
  }, [filtered, viewMode])

  // Per-address columns
  const aggColumns: ColumnDef<AggregatedRow, any>[] = useMemo(() => {
    const cols: ColumnDef<AggregatedRow, any>[] = [
      aggColumnHelper.accessor('address', {
        header: 'Address',
        cell: (info) => (
          <span className="font-mono">{truncateAddress(info.getValue())}</span>
        ),
      }),
      aggColumnHelper.display({
        id: 'hops',
        header: 'Hops',
        cell: (info) => info.row.original.hops.map((h) => `H${h}`).join(', '),
      }),
      aggColumnHelper.accessor('totalCommitted', {
        header: 'Committed',
        cell: (info) => formatUsdc(info.getValue()),
        sortingFn: (a, b) => {
          const av = a.original.totalCommitted
          const bv = b.original.totalCommitted
          return av > bv ? 1 : av < bv ? -1 : 0
        },
      }),
      aggColumnHelper.accessor('totalCap', {
        header: 'Cap',
        cell: (info) => formatUsdc(info.getValue()),
      }),
      aggColumnHelper.display({
        id: 'invites',
        header: 'Invites',
        cell: (info) => {
          const row = info.row.original
          return `${row.totalInvitesUsed} / ${row.totalInvitesTotal}`
        },
      }),
    ]

    if (phase >= 1) {
      cols.push(
        aggColumnHelper.accessor('allocatedArm', {
          id: 'allocatedArm',
          header: 'ARM Allocated',
          cell: (info) => {
            const val = info.getValue()
            return val !== null ? formatArm(val as bigint) : '-'
          },
        }),
        aggColumnHelper.display({
          id: 'claimed',
          header: 'Claimed',
          cell: (info) => {
            const row = info.row.original
            if (row.allocatedArm === null) return '-'
            return (
              <span className="whitespace-nowrap">
                ARM {row.armClaimed ? '✓' : '✗'}
                {row.refundUsdc !== null && row.refundUsdc > 0n && (
                  <> Refund {row.refundClaimed ? '✓' : '✗'}</>
                )}
              </span>
            )
          },
        }),
      )
    }

    return cols
  }, [phase])

  // Table for per-hop view
  const perHopTable = useReactTable({
    data: filtered,
    columns: perHopColumns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  })

  // Table for per-address view
  const aggTable = useReactTable({
    data: aggregated,
    columns: aggColumns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
  })

  const dataCount = viewMode === 'per-hop' ? filtered.length : aggregated.length

  // Generic renderer — keeps each branch's Table<T> concrete so flexRender's
  // column-context generics resolve correctly (a ternary between Table<A> and
  // Table<B> yields a union that flexRender can't narrow through).
  function TableBody<T>({ table }: { table: TanstackTable<T> }) {
    return (
      <table className="w-full text-xs">
        <thead>
          {table.getHeaderGroups().map((headerGroup) => (
            <tr key={headerGroup.id} className="border-b border-border">
              {headerGroup.headers.map((header) => (
                <th
                  key={header.id}
                  className="py-1 pr-4 text-left text-muted-foreground cursor-pointer hover:text-foreground"
                  onClick={header.column.getToggleSortingHandler()}
                >
                  {flexRender(header.column.columnDef.header, header.getContext())}
                  {header.column.getIsSorted() === 'asc' ? ' ^' : ''}
                  {header.column.getIsSorted() === 'desc' ? ' v' : ''}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row) => (
            <tr key={row.id} className="border-b border-border/30 hover:bg-muted/50">
              {row.getVisibleCells().map((cell) => (
                <td key={cell.id} className="py-1 pr-4">
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    )
  }

  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium">Participants</h2>
        <span className="text-xs text-muted-foreground">{dataCount} entries</span>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        {/* View mode toggle */}
        <div className="flex rounded border border-input overflow-hidden">
          <button
            className={`px-2 py-1 text-[10px] ${viewMode === 'per-hop' ? 'bg-primary text-primary-foreground' : 'bg-background text-muted-foreground'}`}
            onClick={() => setViewModeWithSort('per-hop')}
          >
            Per-Hop
          </button>
          <button
            className={`px-2 py-1 text-[10px] ${viewMode === 'per-address' ? 'bg-primary text-primary-foreground' : 'bg-background text-muted-foreground'}`}
            onClick={() => setViewModeWithSort('per-address')}
          >
            Per-Address
          </button>
        </div>

        <select
          className="rounded border border-input bg-background px-2 py-1 text-xs"
          value={hopFilter ?? 'all'}
          onChange={(e) => setHopFilter(e.target.value === 'all' ? null : Number(e.target.value))}
        >
          <option value="all">All Hops</option>
          <option value="0">Seed (hop-0)</option>
          <option value="1">Hop-1</option>
          <option value="2">Hop-2</option>
        </select>

        <select
          className="rounded border border-input bg-background px-2 py-1 text-xs"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as 'all' | 'committed' | 'invited')}
        >
          <option value="all">All Status</option>
          <option value="committed">Committed</option>
          <option value="invited">Invited Only</option>
        </select>

        {/* Post-finalization claim filter */}
        {phase >= 1 && (
          <select
            className="rounded border border-input bg-background px-2 py-1 text-xs"
            value={claimFilter}
            onChange={(e) => setClaimFilter(e.target.value as 'all' | 'claimed' | 'unclaimed')}
          >
            <option value="all">All Claims</option>
            <option value="claimed">Claimed</option>
            <option value="unclaimed">Unclaimed</option>
          </select>
        )}

        <input
          type="text"
          placeholder="Search address..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 min-w-[150px] rounded border border-input bg-background px-2 py-1 text-xs font-mono placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        />
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        {viewMode === 'per-hop' ? (
          <TableBody table={perHopTable} />
        ) : (
          <TableBody table={aggTable} />
        )}
        {dataCount === 0 && (
          <div className="text-xs text-muted-foreground text-center py-4">No participants</div>
        )}
      </div>
    </div>
  )
}
