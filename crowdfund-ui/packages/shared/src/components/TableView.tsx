// ABOUTME: Sortable, searchable, filterable participant table using @tanstack/react-table.
// ABOUTME: Displays address summaries with per-hop breakdown and allocation status.

import { useMemo, useState, useEffect, useRef, useCallback, Fragment } from 'react'
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
import { Search, Users } from 'lucide-react'
import { formatUsdc, formatArm, hopLabel, truncateAddress } from '../lib/format.js'
import { HOP_CONFIGS } from '../lib/constants.js'
import type { AddressSummary, GraphNode } from '../lib/graph.js'
import type { HopStatsData } from './StatsBar.js'
import { NodeDetail } from './NodeDetail.js'
import { EmptyState } from './EmptyState.js'
import { Skeleton } from './ui/skeleton.js'

export interface TableViewProps {
  summaries: AddressSummary[]
  nodes: Map<string, GraphNode>
  selectedAddress: string | null
  onSelectAddress: (addr: string | null) => void
  searchQuery: string
  phase: number
  resolveENS?: (addr: string) => string | null
  hoveredAddress?: string | null
  hopStats?: HopStatsData[]
  saleSize?: bigint
  connectedAddress?: string | null
  /** When true with no rows yet, renders skeleton rows instead of the empty-state cell. */
  isLoading?: boolean
}

function displayAddress(addr: string, resolve?: (a: string) => string | null): string {
  if (addr === 'armada') return 'Armada'
  const ens = resolve?.(addr)
  return ens ?? truncateAddress(addr)
}

/** Compute which hop indices are oversubscribed (demand > ceiling allocation) */
function getOversubscribedHops(hopStats?: HopStatsData[], saleSize?: bigint): Set<number> {
  const result = new Set<number>()
  if (!hopStats || !saleSize || saleSize === 0n) return result
  for (let i = 0; i < hopStats.length; i++) {
    const ceiling = (saleSize * BigInt(HOP_CONFIGS[i].ceilingBps)) / 10000n
    if (ceiling > 0n && hopStats[i].cappedCommitted > ceiling) {
      result.add(i)
    }
  }
  return result
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
    hoveredAddress,
    hopStats,
    saleSize,
    connectedAddress,
    isLoading,
  } = props

  const [sorting, setSorting] = useState<SortingState>([{ id: 'totalCommitted', desc: true }])
  const [expanded, setExpanded] = useState<ExpandedState>({})
  const [hopFilter, setHopFilter] = useState<number | null>(null)
  const [multiHopOnly, setMultiHopOnly] = useState(false)
  const [oversubOnly, setOversubOnly] = useState(false)
  const rowRefs = useRef<Map<string, HTMLTableRowElement>>(new Map())

  const oversubscribedHops = useMemo(
    () => getOversubscribedHops(hopStats, saleSize),
    [hopStats, saleSize],
  )

  // Sort connected address to top, then apply other filters
  const sortedSummaries = useMemo(() => {
    if (!connectedAddress) return summaries
    const connected = connectedAddress.toLowerCase()
    return [...summaries].sort((a, b) => {
      const aConn = a.address === connected ? -1 : 0
      const bConn = b.address === connected ? -1 : 0
      return aConn - bConn
    })
  }, [summaries, connectedAddress])

  // Pre-filter by hop, multi-hop, and oversubscribed toggles
  const filteredSummaries = useMemo(() => {
    let filtered = sortedSummaries
    if (hopFilter !== null) {
      filtered = filtered.filter((s) => s.hops.includes(hopFilter))
    }
    if (multiHopOnly) {
      filtered = filtered.filter((s) => s.hops.length > 1)
    }
    if (oversubOnly && oversubscribedHops.size > 0) {
      filtered = filtered.filter((s) =>
        s.hops.some((h) => oversubscribedHops.has(h)),
      )
    }
    return filtered
  }, [summaries, hopFilter, multiHopOnly, oversubOnly, oversubscribedHops])

  // Scroll to selected row when selection changes
  useEffect(() => {
    if (!selectedAddress) return
    const el = rowRefs.current.get(selectedAddress)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
  }, [selectedAddress])

  const handleInviterClick = useCallback(
    (e: React.MouseEvent, inviterAddr: string) => {
      e.stopPropagation()
      if (inviterAddr === 'armada') return
      onSelectAddress(inviterAddr)
    },
    [onSelectAddress],
  )

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
        cell: (info) => {
          const inviter = info.getValue()
          const label = displayAddress(inviter, resolveENS)
          if (inviter === 'armada') {
            return <span className="text-xs text-muted-foreground">{label}</span>
          }
          return (
            <button
              className="text-xs text-muted-foreground underline decoration-dotted hover:text-foreground cursor-pointer"
              onClick={(e) => handleInviterClick(e, inviter)}
            >
              {label}
            </button>
          )
        },
        sortingFn: 'alphanumeric',
      }),
      // Invites column: used / total across all hops
      columnHelper.display({
        id: 'invites',
        header: 'Invites',
        cell: (info) => {
          const addr = info.row.original.address
          let used = 0
          let total = 0
          for (const hop of info.row.original.hops) {
            const node = nodes.get(`${addr}-${hop}`)
            if (node) {
              used += node.invitesUsed
              total += node.invitesUsed + node.invitesAvailable
            }
          }
          return <span className="text-xs">{used}/{total}</span>
        },
        sortingFn: (rowA, rowB) => {
          const getUsed = (row: Row<AddressSummary>) => {
            let used = 0
            for (const hop of row.original.hops) {
              const node = nodes.get(`${row.original.address}-${hop}`)
              if (node) used += node.invitesUsed
            }
            return used
          }
          return getUsed(rowA) - getUsed(rowB)
        },
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
  }, [phase, resolveENS, nodes, handleInviterClick])

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

  const colCount = phase === 1 ? 7 : 5

  function handleRowClick(row: Row<AddressSummary>) {
    const addr = row.original.address
    const isSelected = selectedAddress === addr
    onSelectAddress(isSelected ? null : addr)
    row.toggleExpanded()
  }

  return (
    <div className="space-y-2">
      {/* Hop filter tabs + toggle filters */}
      <div className="flex flex-wrap items-center gap-1 text-xs">
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
        <span className="mx-1 text-border">|</span>
        <button
          className={`px-2 py-1 rounded ${multiHopOnly ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:text-foreground'}`}
          onClick={() => setMultiHopOnly(!multiHopOnly)}
        >
          Multi-hop
        </button>
        {oversubscribedHops.size > 0 && (
          <button
            className={`px-2 py-1 rounded ${oversubOnly ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:text-foreground'}`}
            onClick={() => setOversubOnly(!oversubOnly)}
          >
            Oversubscribed
          </button>
        )}
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
              const addr = row.original.address
              const isSelected = selectedAddress === addr
              const isHovered = hoveredAddress === addr
              const isConnected = !!connectedAddress && addr === connectedAddress.toLowerCase()
              const hopNodes = row.original.hops
                .map((hop) => nodes.get(`${addr}-${hop}`))
                .filter((n): n is GraphNode => n !== undefined)

              return (
                <Fragment key={row.id}>
                  <tr
                    ref={(el) => {
                      if (el) rowRefs.current.set(addr, el)
                      else rowRefs.current.delete(addr)
                    }}
                    className={`border-t border-border cursor-pointer transition-colors ${
                      isSelected
                        ? 'bg-primary/10'
                        : isConnected
                          ? 'bg-cyan-500/10 border-l-2 border-l-cyan-500'
                          : isHovered
                            ? 'bg-muted/15'
                            : 'hover:bg-muted/30'
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
              isLoading ? (
                Array.from({ length: 5 }).map((_, i) => (
                  <tr key={`skeleton-${i}`} className="border-b border-border/40">
                    {Array.from({ length: colCount }).map((_, j) => (
                      <td key={j} className="px-3 py-3">
                        <Skeleton className="h-4 w-full" />
                      </td>
                    ))}
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={colCount} className="p-0">
                    {searchQuery ? (
                      <EmptyState
                        icon={Search}
                        title="No matching participants"
                        description={`No participants match "${searchQuery}".`}
                      />
                    ) : (
                      <EmptyState
                        icon={Users}
                        title="No participants yet"
                        description="The invite graph is empty until the first commit lands."
                      />
                    )}
                  </td>
                </tr>
              )
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
