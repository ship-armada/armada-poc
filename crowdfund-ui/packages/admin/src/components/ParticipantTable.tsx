// ABOUTME: Sortable, filterable participant table using @tanstack/react-table.
// ABOUTME: Shows per-node data with hop filter, status filter, and address search.

import { useState, useMemo } from 'react'
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  useReactTable,
  type SortingState,
  type ColumnDef,
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
}

const columnHelper = createColumnHelper<ParticipantRow>()

const allColumns: ColumnDef<ParticipantRow, any>[] = [
  columnHelper.accessor('address', {
    header: 'Address',
    cell: (info) => (
      <span className="font-mono">{truncateAddress(info.getValue())}</span>
    ),
  }),
  columnHelper.accessor('hop', {
    header: 'Hop',
    cell: (info) => hopLabel(info.getValue()),
  }),
  columnHelper.accessor('invitedBy', {
    header: 'Invited By',
    cell: (info) => {
      const val = info.getValue()
      return (
        <span className="font-mono">{val.length > 0 ? truncateAddress(val[0]) : '-'}</span>
      )
    },
  }),
  columnHelper.accessor('committed', {
    header: 'Committed',
    cell: (info) => formatUsdc(info.getValue()),
    sortingFn: (a, b) => {
      const av = a.original.committed
      const bv = b.original.committed
      return av > bv ? 1 : av < bv ? -1 : 0
    },
  }),
  columnHelper.accessor('effectiveCap', {
    header: 'Cap',
    cell: (info) => formatUsdc(info.getValue()),
  }),
  columnHelper.accessor('invitesUsed', {
    header: 'Invites',
    cell: (info) => `${info.getValue()} / ${info.row.original.invitesTotal}`,
  }),
  columnHelper.accessor('allocatedArm', {
    id: 'allocatedArm',
    header: 'ARM Allocated',
    cell: (info) => {
      const val = info.getValue()
      return val !== null ? formatArm(val as bigint) : '-'
    },
  }),
  columnHelper.accessor('claimed', {
    id: 'claimed',
    header: 'Claimed',
    cell: (info) => {
      const val = info.getValue()
      if (val === null) return '-'
      return val ? 'Yes' : 'No'
    },
  }),
]

export function ParticipantTable({ participants, phase }: ParticipantTableProps) {
  const [sorting, setSorting] = useState<SortingState>([
    { id: 'committed', desc: true },
  ])
  const [hopFilter, setHopFilter] = useState<number | null>(null)
  const [statusFilter, setStatusFilter] = useState<'all' | 'committed' | 'invited'>('all')
  const [search, setSearch] = useState('')

  const filtered = useMemo(() => {
    return participants.filter((p) => {
      if (hopFilter !== null && p.hop !== hopFilter) return false
      if (statusFilter === 'committed' && p.committed === 0n) return false
      if (statusFilter === 'invited' && p.committed > 0n) return false
      if (search && !p.address.toLowerCase().includes(search.toLowerCase())) return false
      return true
    })
  }, [participants, hopFilter, statusFilter, search])

  // Hide post-finalization columns before finalization
  const visibleColumns = useMemo(() => {
    if (phase < 1) return allColumns.filter((c) => {
      const id = 'id' in c ? c.id : ('accessorKey' in c ? c.accessorKey : '')
      return id !== 'allocatedArm' && id !== 'claimed'
    })
    return allColumns
  }, [phase])

  const table = useReactTable({
    data: filtered,
    columns: visibleColumns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  })

  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium">Participants</h2>
        <span className="text-xs text-muted-foreground">{filtered.length} entries</span>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
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
        {filtered.length === 0 && (
          <div className="text-xs text-muted-foreground text-center py-4">No participants</div>
        )}
      </div>
    </div>
  )
}
