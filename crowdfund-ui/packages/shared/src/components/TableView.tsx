// ABOUTME: Sortable, searchable, filterable participant table using @tanstack/react-table.
// ABOUTME: Displays address summaries with per-hop breakdown and allocation status.

import { useMemo, useState, Fragment } from 'react'
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  getExpandedRowModel,
  flexRender,
  createColumnHelper,
  type SortingState,
  type ExpandedState,
  type ColumnFiltersState,
  type ColumnDef,
  type Row,
} from '@tanstack/react-table'
import { formatUsdc, formatArm, hopLabel, truncateAddress } from '../lib/format.js'
import type { AddressSummary, GraphNode } from '../lib/graph.js'
import { NodeDetail } from './NodeDetail.js'

export interface TableViewProps {
  summaries: AddressSummary[]
  nodes: Map<string, GraphNode>
  selectedAddress: string | null
  onSelectAddress: (addr: string | null) => void
  searchQuery: string
  phase: number
  resolveENS?: (addr: string) => string | null
}

function displayAddress(addr: string, resolve?: (a: string) => string | null): string {
  if (addr === 'armada') return 'Armada'
  const ens = resolve?.(addr)
  return ens ?? truncateAddress(addr)
}

const columnHelper = createColumnHelper<AddressSummary>()

export function TableView(props: TableViewProps) {
  const {
    summaries,
    nodes,
    selectedAddress,
    onSelectAddress,
    searchQuery,
    phase,
    resolveENS,
  } = props

  const [sorting, setSorting] = useState<SortingState>([{ id: 'committed', desc: true }])
  const [expanded, setExpanded] = useState<ExpandedState>({})
  const [hopFilter, setHopFilter] = useState<number | null>(null)

  // Pre-filter by hop before handing to the table
  const filteredSummaries = useMemo(() => {
    if (hopFilter === null) return summaries
    return summaries.filter((s) => s.hops.includes(hopFilter))
  }, [summaries, hopFilter])

  const columns = useMemo(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cols: ColumnDef<AddressSummary, any>[] = [
      columnHelper.accessor('address', {
        header: 'Address',
        cell: (info) => (
          <span className="font-mono text-xs">
            {displayAddress(info.getValue(), resolveENS)}
          </span>
        ),
        sortingFn: 'alphanumeric',
        filterFn: (row, _columnId, filterValue: string) => {
          const addr = row.original.address
          const q = filterValue.toLowerCase()
          if (addr.toLowerCase().includes(q)) return true
          const ens = resolveENS?.(addr)
          if (ens && ens.toLowerCase().includes(q)) return true
          return false
        },
      }),
      columnHelper.accessor('hops', {
        header: 'Hop(s)',
        cell: (info) => (
          <span className="text-xs">
            {info.getValue().map((h: number) => hopLabel(h)).join(', ')}
          </span>
        ),
        sortingFn: (rowA, rowB) =>
          rowA.original.hops.length - rowB.original.hops.length,
      }),
      columnHelper.accessor('totalCommitted', {
        header: 'Committed',
        cell: (info) => (
          <span className="font-medium">{formatUsdc(info.getValue())}</span>
        ),
        sortingFn: (rowA, rowB) => {
          const a = rowA.original.totalCommitted
          const b = rowB.original.totalCommitted
          return a > b ? 1 : a < b ? -1 : 0
        },
      }),
      columnHelper.accessor('displayInviter', {
        header: 'Invited by',
        cell: (info) => (
          <span className="text-xs text-muted-foreground">
            {displayAddress(info.getValue(), resolveENS)}
          </span>
        ),
        sortingFn: 'alphanumeric',
      }),
    ]

    if (phase === 1) {
      cols.push(
        columnHelper.accessor('allocatedArm', {
          header: 'Allocated',
          cell: (info) => {
            const val = info.getValue()
            return val !== null ? formatArm(val) : '—'
          },
          sortingFn: (rowA, rowB) => {
            const a = rowA.original.allocatedArm ?? 0n
            const b = rowB.original.allocatedArm ?? 0n
            return a > b ? 1 : a < b ? -1 : 0
          },
        }),
        columnHelper.display({
          id: 'claimed',
          header: 'Claimed',
          cell: (info) => {
            const s = info.row.original
            return (
              <span className="text-xs">
                {s.armClaimed && <span className="text-success">ARM</span>}
                {s.armClaimed && s.refundClaimed && ' + '}
                {s.refundClaimed && <span className="text-success">Refund</span>}
                {!s.armClaimed && !s.refundClaimed && '—'}
              </span>
            )
          },
        }),
      )
    }

    return cols
  }, [phase, resolveENS])

  // Apply search query as a column filter on the address column
  const columnFilters = useMemo<ColumnFiltersState>(() => {
    if (!searchQuery) return []
    return [{ id: 'address', value: searchQuery }]
  }, [searchQuery])

  const table = useReactTable({
    data: filteredSummaries,
    columns,
    state: {
      sorting,
      expanded,
      columnFilters,
    },
    onSortingChange: setSorting,
    onExpandedChange: setExpanded,
    getRowCanExpand: () => true,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
  })

  const colCount = phase === 1 ? 6 : 4

  function handleRowClick(row: Row<AddressSummary>) {
    const addr = row.original.address
    const isSelected = selectedAddress === addr
    onSelectAddress(isSelected ? null : addr)
    row.toggleExpanded()
  }

  return (
    <div className="space-y-2">
      {/* Hop filter tabs */}
      <div className="flex gap-1 text-xs">
        <button
          className={`px-2 py-1 rounded ${hopFilter === null ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:text-foreground'}`}
          onClick={() => setHopFilter(null)}
        >
          All
        </button>
        {[0, 1, 2].map((hop) => (
          <button
            key={hop}
            className={`px-2 py-1 rounded ${hopFilter === hop ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:text-foreground'}`}
            onClick={() => setHopFilter(hop === hopFilter ? null : hop)}
          >
            {hopLabel(hop)}
          </button>
        ))}
      </div>

      {/* Table */}
      <div className="rounded-lg border border-border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <th
                    key={header.id}
                    className={`px-3 py-2 text-left text-xs font-medium text-muted-foreground ${
                      header.column.getCanSort()
                        ? 'cursor-pointer select-none hover:text-foreground'
                        : ''
                    }`}
                    onClick={header.column.getToggleSortingHandler()}
                  >
                    <span className="inline-flex items-center gap-1">
                      {flexRender(header.column.columnDef.header, header.getContext())}
                      {{
                        asc: <span className="text-foreground">↑</span>,
                        desc: <span className="text-foreground">↓</span>,
                      }[header.column.getIsSorted() as string] ?? null}
                    </span>
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => {
              const isSelected = selectedAddress === row.original.address
              const hopNodes = row.original.hops
                .map((hop) => nodes.get(`${row.original.address}-${hop}`))
                .filter((n): n is GraphNode => n !== undefined)

              return (
                <Fragment key={row.id}>
                  <tr
                    className={`border-t border-border cursor-pointer transition-colors ${
                      isSelected ? 'bg-primary/10' : 'hover:bg-muted/30'
                    }`}
                    onClick={() => handleRowClick(row)}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <td key={cell.id} className="px-3 py-2">
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    ))}
                  </tr>
                  {row.getIsExpanded() && (
                    <tr>
                      <td colSpan={colCount} className="px-3 py-3 bg-muted/20">
                        <NodeDetail
                          summary={row.original}
                          hopNodes={hopNodes}
                          resolveENS={resolveENS}
                          phase={phase}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
            {table.getRowModel().rows.length === 0 && (
              <tr>
                <td
                  colSpan={colCount}
                  className="px-3 py-8 text-center text-muted-foreground"
                >
                  {searchQuery ? 'No matching participants' : 'No participants yet'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Row count */}
      <div className="text-xs text-muted-foreground">
        {table.getFilteredRowModel().rows.length} participant
        {table.getFilteredRowModel().rows.length !== 1 ? 's' : ''}
        {searchQuery && ` matching "${searchQuery}"`}
      </div>
    </div>
  )
}
