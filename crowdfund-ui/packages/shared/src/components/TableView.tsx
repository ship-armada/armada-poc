// ABOUTME: Sortable, searchable, filterable participant table.
// ABOUTME: Displays address summaries with per-hop breakdown and allocation status.

import { useMemo, useState, useCallback } from 'react'
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

type SortField = 'address' | 'hops' | 'committed' | 'inviter' | 'allocated'
type SortDir = 'asc' | 'desc'

function displayAddress(addr: string, resolve?: (a: string) => string | null): string {
  if (addr === 'armada') return 'Armada'
  const ens = resolve?.(addr)
  return ens ?? truncateAddress(addr)
}

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

  const [sortField, setSortField] = useState<SortField>('committed')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [expandedAddr, setExpandedAddr] = useState<string | null>(null)
  const [hopFilter, setHopFilter] = useState<number | null>(null)

  const handleSort = useCallback(
    (field: SortField) => {
      if (sortField === field) {
        setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
      } else {
        setSortField(field)
        setSortDir('desc')
      }
    },
    [sortField],
  )

  // Filter and sort
  const rows = useMemo(() => {
    let filtered = summaries

    // Search filter
    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      filtered = filtered.filter((s) => {
        if (s.address.toLowerCase().includes(q)) return true
        const ens = resolveENS?.(s.address)
        if (ens && ens.toLowerCase().includes(q)) return true
        return false
      })
    }

    // Hop filter
    if (hopFilter !== null) {
      filtered = filtered.filter((s) => s.hops.includes(hopFilter))
    }

    // Sort
    const sorted = [...filtered]
    sorted.sort((a, b) => {
      let cmp = 0
      switch (sortField) {
        case 'address':
          cmp = a.address.localeCompare(b.address)
          break
        case 'hops':
          cmp = a.hops.length - b.hops.length
          break
        case 'committed':
          cmp = a.totalCommitted > b.totalCommitted ? 1 : a.totalCommitted < b.totalCommitted ? -1 : 0
          break
        case 'inviter':
          cmp = a.displayInviter.localeCompare(b.displayInviter)
          break
        case 'allocated':
          cmp =
            (a.allocatedArm ?? 0n) > (b.allocatedArm ?? 0n)
              ? 1
              : (a.allocatedArm ?? 0n) < (b.allocatedArm ?? 0n)
                ? -1
                : 0
          break
      }
      return sortDir === 'asc' ? cmp : -cmp
    })

    return sorted
  }, [summaries, searchQuery, hopFilter, sortField, sortDir, resolveENS])

  const SortHeader = ({
    field,
    children,
  }: {
    field: SortField
    children: React.ReactNode
  }) => (
    <th
      className="px-3 py-2 text-left text-xs font-medium text-muted-foreground cursor-pointer select-none hover:text-foreground"
      onClick={() => handleSort(field)}
    >
      <span className="inline-flex items-center gap-1">
        {children}
        {sortField === field && (
          <span className="text-foreground">{sortDir === 'asc' ? '↑' : '↓'}</span>
        )}
      </span>
    </th>
  )

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
            <tr>
              <SortHeader field="address">Address</SortHeader>
              <SortHeader field="hops">Hop(s)</SortHeader>
              <SortHeader field="committed">Committed</SortHeader>
              <SortHeader field="inviter">Invited by</SortHeader>
              {phase === 1 && <SortHeader field="allocated">Allocated</SortHeader>}
              {phase === 1 && <th className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">Claimed</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((summary) => {
              const isSelected = selectedAddress === summary.address
              const isExpanded = expandedAddr === summary.address
              const hopNodes = summary.hops
                .map((hop) => nodes.get(`${summary.address}-${hop}`))
                .filter((n): n is GraphNode => n !== undefined)

              return (
                <tbody key={summary.address}>
                  <tr
                    className={`border-t border-border cursor-pointer transition-colors ${
                      isSelected ? 'bg-primary/10' : 'hover:bg-muted/30'
                    }`}
                    onClick={() => {
                      onSelectAddress(isSelected ? null : summary.address)
                      setExpandedAddr(isExpanded ? null : summary.address)
                    }}
                  >
                    <td className="px-3 py-2 font-mono text-xs">
                      {displayAddress(summary.address, resolveENS)}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {summary.hops.map((h) => hopLabel(h)).join(', ')}
                    </td>
                    <td className="px-3 py-2 font-medium">
                      {formatUsdc(summary.totalCommitted)}
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {displayAddress(summary.displayInviter, resolveENS)}
                    </td>
                    {phase === 1 && (
                      <td className="px-3 py-2">
                        {summary.allocatedArm !== null
                          ? formatArm(summary.allocatedArm)
                          : '—'}
                      </td>
                    )}
                    {phase === 1 && (
                      <td className="px-3 py-2 text-xs">
                        {summary.armClaimed && <span className="text-success">ARM</span>}
                        {summary.armClaimed && summary.refundClaimed && ' + '}
                        {summary.refundClaimed && <span className="text-success">Refund</span>}
                        {!summary.armClaimed && !summary.refundClaimed && '—'}
                      </td>
                    )}
                  </tr>
                  {isExpanded && (
                    <tr>
                      <td
                        colSpan={phase === 1 ? 6 : 4}
                        className="px-3 py-3 bg-muted/20"
                      >
                        <NodeDetail
                          summary={summary}
                          hopNodes={hopNodes}
                          resolveENS={resolveENS}
                          phase={phase}
                        />
                      </td>
                    </tr>
                  )}
                </tbody>
              )
            })}
            {rows.length === 0 && (
              <tr>
                <td
                  colSpan={phase === 1 ? 6 : 4}
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
        {rows.length} participant{rows.length !== 1 ? 's' : ''}
        {searchQuery && ` matching "${searchQuery}"`}
      </div>
    </div>
  )
}
