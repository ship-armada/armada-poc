// ABOUTME: Sortable, searchable, filterable participant table using @tanstack/react-table.
// ABOUTME: Displays address summaries with per-hop breakdown and allocation status.

import { useMemo, useState, useEffect, useRef, useCallback, Fragment } from 'react'
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  getExpandedRowModel,
  getPaginationRowModel,
  flexRender,
  createColumnHelper,
  type SortingState,
  type ExpandedState,
  type ColumnFiltersState,
  type ColumnDef,
  type PaginationState,
  type Row,
} from '@tanstack/react-table'
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, ChevronsUpDown, Copy, Crosshair, ExternalLink, MoreHorizontal, Search, UserRound, Users } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '../lib/utils.js'
import { formatUsdc, formatArm, truncateAddress } from '../lib/format.js'
import { HOP_CONFIGS } from '../lib/constants.js'
import type { AddressSummary, GraphNode } from '../lib/graph.js'
import type { HopStatsData } from './StatsBar.js'
import { NodeDetail } from './NodeDetail.js'
import { SearchBar } from './SearchBar.js'
import { EmptyState } from './EmptyState.js'
import { CopyToast } from './CopyToast.js'
import { Button } from './ui/button.js'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover.js'
import { Skeleton } from './ui/skeleton.js'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from './ui/tooltip.js'

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
  /**
   * Request to scroll a row into view. Decoupled from `selectedAddress` so that
   * clicking a tree node selects without yanking the table scroll position.
   * The tick ensures repeat requests for the same address re-fire the effect.
   */
  focusRequest?: { address: string; tick: number } | null
  /**
   * Optional handler — when provided, the table renders an internal SearchBar
   * in its header row beside the filter pills. The host should also keep
   * `searchQuery` controlled so other consumers (TreeView etc.) stay in sync.
   * Omit to keep the table as a pure rendering surface (legacy behaviour).
   */
  onSearchQueryChange?: (q: string) => void
  /**
   * Optional callback for the per-row "View in tree" action. Hosts that
   * embed a TreeView alongside the table should select + zoom the tree to
   * the given address. Omit to hide the menu item.
   */
  onFocusInTree?: (addr: string) => void
  /**
   * Optional block-explorer base URL (e.g. "https://sepolia.etherscan.io").
   * When provided, the per-row actions menu includes an "Open on explorer"
   * link to `<explorerUrl>/address/<addr>`. Omit to hide the menu item.
   */
  explorerUrl?: string
}

function displayAddress(addr: string, resolve?: (a: string) => string | null): string {
  if (addr === 'armada') return 'Armada'
  const ens = resolve?.(addr)
  return ens ?? truncateAddress(addr)
}

/** Per-hop CSS for the avatar circle. Mirrors the seed-node recipe used in
 *  TreeView (hop-0 specifically): a 15% hop-tint blended with the card
 *  surface, a full-saturation 2px ring of the same hop colour, and a soft
 *  outer glow approximating TreeView's Gaussian-blur halo. Icon colour
 *  uses the brighter `--hop-N-icon` variant where defined (hop-2 falls
 *  back to its base hue since no `-icon` variant exists in theme). */
function hopAvatarStyle(hop: number): React.CSSProperties {
  const v = hop === 0 ? '--hop-0' : hop === 1 ? '--hop-1' : '--hop-2'
  const iv = hop === 0 ? '--hop-0-icon' : hop === 1 ? '--hop-1-icon' : '--hop-2'
  return {
    background: `color-mix(in oklch, var(${v}) 15%, var(--card) 85%)`,
    border: `2px solid var(${v})`,
    boxShadow: `0 0 4px color-mix(in oklch, var(${v}) 22%, transparent)`,
    color: `var(${iv})`,
  }
}

/** Lowest hop a row participates in — drives the avatar colour. */
function primaryHop(hops: ReadonlyArray<number>): number {
  if (hops.length === 0) return 0
  let min = hops[0]
  for (const h of hops) if (h < min) min = h
  return min
}

/** Text colour class for the per-hop badge in the Hop(s) column. Uses the
 *  same `--hop-N` tokens as the avatar so a row's avatar and badge stay
 *  colour-matched. Background is intentionally absent — text-only badge. */
function hopBadgeClasses(hop: number): string {
  switch (hop) {
    case 0:
      return 'text-hop-0'
    case 1:
      return 'text-hop-1'
    default:
      return 'text-hop-2'
  }
}

/** Pill copy for the Hop(s) column. The wider table chrome already names the
 *  participation context, so the badge can use a tight "Hop N" form rather
 *  than the verbose `hopLabel()` output ("Seed (hop-0)"). */
function hopBadgeLabel(hop: number): string {
  return `Hop ${hop}`
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

/** Build the windowed page list for the pagination control: always shows
 *  page 1 + the last page, with the current page surrounded by ±span
 *  neighbours, and `'gap'` placeholders for any compressed range.
 *  e.g. current=5 of 63 with span=1 → [1, 'gap', 4, 5, 6, 'gap', 63]. */
function pageWindow(
  current: number,
  total: number,
  span = 1,
): Array<number | 'gap'> {
  if (total <= 1) return total === 1 ? [1] : []
  if (total <= 5 + span * 2) {
    return Array.from({ length: total }, (_, i) => i + 1)
  }
  const result: Array<number | 'gap'> = [1]
  const start = Math.max(2, current - span)
  const end = Math.min(total - 1, current + span)
  if (start > 2) result.push('gap')
  for (let i = start; i <= end; i++) result.push(i)
  if (end < total - 1) result.push('gap')
  result.push(total)
  return result
}

/** 32px square page button. Mirrors FilterPill's active/inactive treatment
 *  so the table footer feels of-a-piece with the header filter row. */
function PageButton({
  active,
  disabled,
  onClick,
  ariaLabel,
  ariaCurrent,
  children,
}: {
  active?: boolean
  disabled?: boolean
  onClick: () => void
  ariaLabel: string
  ariaCurrent?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-current={ariaCurrent ? 'page' : undefined}
      className={cn(
        'inline-flex size-8 items-center justify-center rounded-lg text-xs font-medium tabular-nums transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-40',
        active
          ? 'bg-primary text-primary-foreground'
          : 'bg-muted/40 text-muted-foreground hover:bg-muted/60 hover:text-foreground',
      )}
    >
      {children}
    </button>
  )
}

/** Pill button for the table's filter row (All / Hop 0 / Hop 1 / Hop 2 /
 *  Multi-hop / Oversubscribed). Active state uses our `--primary` token,
 *  inactive uses a soft muted fill that hovers darker. */
function FilterPill({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-lg px-3 py-1.5 text-xs font-medium transition-colors',
        active
          ? // Subtle horizontal gradient on the active pill — adds a touch of
            // depth vs. a flat fill, matches the progress-bar treatment.
            'bg-gradient-to-r from-primary to-primary/85 text-primary-foreground'
          : 'bg-muted/40 text-muted-foreground hover:bg-muted/60 hover:text-foreground',
      )}
    >
      {children}
    </button>
  )
}

/** Per-column widths applied to the header `<th>`. The browser cascades the
 *  width to body cells (since the table is `width: 100%`), letting the
 *  remaining columns share the leftover space. Address is narrower than its
 *  natural width to give the data columns more breathing room; Actions is
 *  tight since it only holds a single icon button. */
function columnWidthStyle(columnId: string): React.CSSProperties | undefined {
  switch (columnId) {
    case 'address':
      return { width: '240px' }
    case 'actions':
      return { width: '72px' }
    default:
      return undefined
  }
}

/** Per-row "⋯" menu rendered in the Actions column. Items only appear when
 *  the host wires them in — copy is unconditional, "View in tree" needs an
 *  `onFocusInTree` callback, "Open on explorer" needs an `explorerUrl`. */
function RowActions({
  address,
  explorerUrl,
  onFocusInTree,
}: {
  address: string
  explorerUrl?: string
  onFocusInTree?: (addr: string) => void
}) {
  const [open, setOpen] = useState(false)

  // All click handlers stop propagation so the row's own click handler
  // (which toggles selection + expansion) doesn't fire.
  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation()
    navigator.clipboard.writeText(address).then(
      () => toast.success(<CopyToast>Address copied</CopyToast>),
      () => toast.error('Clipboard write failed'),
    )
    setOpen(false)
  }
  const handleFocus = (e: React.MouseEvent) => {
    e.stopPropagation()
    onFocusInTree?.(address)
    setOpen(false)
  }
  const handleExplorer = (e: React.MouseEvent) => {
    e.stopPropagation()
    setOpen(false)
  }

  const itemClass =
    'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs text-foreground transition-colors hover:bg-accent hover:text-accent-foreground'

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          // Always visible at a muted tint; row hover lifts the icon
          // toward the foreground tone, direct hover or menu-open goes
          // full presence. Stops propagation so opening the menu doesn't
          // toggle the row's selection / expansion.
          className="size-7 text-muted-foreground/70 transition-colors group-hover:text-foreground/90 hover:text-foreground data-[state=open]:text-foreground"
          aria-label="Row actions"
          onClick={(e) => e.stopPropagation()}
        >
          <MoreHorizontal className="size-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={4} className="w-44 p-1">
        <button type="button" className={itemClass} onClick={handleCopy}>
          <Copy className="size-3.5" />
          Copy address
        </button>
        {onFocusInTree && (
          <button type="button" className={itemClass} onClick={handleFocus}>
            <Crosshair className="size-3.5" />
            View in tree
          </button>
        )}
        {explorerUrl && (
          <a
            href={`${explorerUrl}/address/${address}`}
            target="_blank"
            rel="noopener noreferrer"
            className={itemClass}
            onClick={handleExplorer}
          >
            <ExternalLink className="size-3.5" />
            Open on explorer
          </a>
        )}
      </PopoverContent>
    </Popover>
  )
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
    hoveredAddress,
    hopStats,
    saleSize,
    connectedAddress,
    isLoading,
    focusRequest,
    onSearchQueryChange,
    onFocusInTree,
    explorerUrl,
  } = props

  const [sorting, setSorting] = useState<SortingState>([{ id: 'totalCommitted', desc: true }])
  const [expanded, setExpanded] = useState<ExpandedState>({})
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 10 })
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

  // Scroll to a row only when an explicit focus request is made (e.g. "View in
  // table" button). Clicking a tree node selects without scrolling.
  useEffect(() => {
    if (!focusRequest) return
    const el = rowRefs.current.get(focusRequest.address)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
  }, [focusRequest])

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
        cell: (info) => {
          const raw = info.getValue()
          const copyable = raw !== 'armada'
          const isThisConnected =
            !!connectedAddress && raw === connectedAddress.toLowerCase()
          const handleCopy = (e: React.MouseEvent) => {
            e.stopPropagation()
            if (!copyable) return
            navigator.clipboard.writeText(raw).then(
              () => toast.success(<CopyToast>Address copied</CopyToast>),
              () => toast.error('Clipboard write failed'),
            )
          }
          const rowPrimaryHop = primaryHop(info.row.original.hops)
          return (
            <span className="inline-flex items-center gap-2 font-mono text-xs">
              {raw !== 'armada' && (
                <span
                  aria-hidden
                  style={hopAvatarStyle(rowPrimaryHop)}
                  className="flex size-7 shrink-0 items-center justify-center rounded-full"
                >
                  <UserRound className="size-3.5" strokeWidth={2} />
                </span>
              )}
              {raw !== 'armada' ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="cursor-help">{displayAddress(raw, resolveENS)}</span>
                  </TooltipTrigger>
                  <TooltipContent side="top">
                    <span className="font-mono text-[11px]">{raw}</span>
                  </TooltipContent>
                </Tooltip>
              ) : (
                <span>{displayAddress(raw, resolveENS)}</span>
              )}
              {isThisConnected && (
                // Connected-wallet badge — uses the teal --hop-connected
                // token to match the row's existing left-rail accent.
                <span className="rounded-md bg-accent-you/15 px-1.5 py-0.5 text-[10px] font-medium text-accent-you">
                  You
                </span>
              )}
              {copyable && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={handleCopy}
                  aria-label="Copy address"
                  className="h-auto p-0.5 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 text-muted-foreground hover:text-foreground transition-opacity"
                >
                  <Copy className="size-3" />
                </Button>
              )}
            </span>
          )
        },
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
        cell: (info) => {
          const hops = info.getValue() as number[]
          return (
            <span className="inline-flex flex-wrap items-center gap-1">
              {hops.map((h) => (
                <span
                  key={h}
                  className={cn(
                    'inline-flex items-center rounded-md px-2 py-1 text-xs tabular-nums',
                    hopBadgeClasses(h),
                  )}
                >
                  {hopBadgeLabel(h)}
                </span>
              ))}
            </span>
          )
        },
        sortingFn: (rowA, rowB) =>
          rowA.original.hops.length - rowB.original.hops.length,
      }),
      columnHelper.accessor('totalCommitted', {
        header: 'Committed',
        cell: (info) => {
          const summary = info.row.original
          const total = summary.hops.length
          let committedCount = 0
          for (const h of summary.hops) {
            if ((summary.perHop.get(h) ?? 0n) > 0n) committedCount += 1
          }
          const fullyCommitted = total > 0 && committedCount === total
          const breakdown = (
            <div className="flex flex-col leading-tight">
              <span className="text-base font-semibold tabular-nums">
                {formatUsdc(info.getValue())}
              </span>
              {total > 0 && (
                <span
                  className={cn(
                    'mt-0.5 text-xs tabular-nums',
                    fullyCommitted ? 'text-primary' : 'text-muted-foreground',
                  )}
                >
                  {committedCount}/{total} committed
                </span>
              )}
            </div>
          )
          // Skip the tooltip when the breakdown wouldn't add information
          // (single position or no positions at all).
          if (total <= 1) return breakdown
          return (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="cursor-help">{breakdown}</span>
              </TooltipTrigger>
              <TooltipContent side="top">
                <div className="flex flex-col gap-0.5 text-[11px] tabular-nums">
                  {summary.hops.map((h) => (
                    <div key={h} className="flex items-center justify-between gap-3">
                      <span>Hop {h}</span>
                      <span>{formatUsdc(summary.perHop.get(h) ?? 0n)}</span>
                    </div>
                  ))}
                </div>
              </TooltipContent>
            </Tooltip>
          )
        },
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
          const isConnectedInviter =
            !!connectedAddress && inviter === connectedAddress.toLowerCase()
          return (
            <span className="inline-flex items-center gap-1.5">
              <button
                type="button"
                onClick={(e) => handleInviterClick(e, inviter)}
                className="cursor-pointer font-mono text-xs text-primary underline-offset-2 transition-colors hover:underline"
              >
                {label}
              </button>
              {isConnectedInviter && (
                <span className="rounded-md bg-accent-you/15 px-1.5 py-0.5 text-[10px] font-medium text-accent-you">
                  You
                </span>
              )}
            </span>
          )
        },
        sortingFn: 'alphanumeric',
      }),
      // Invites column: used / total across all hops
      columnHelper.display({
        id: 'invites',
        header: 'Invites (used / total)',
        cell: (info) => {
          const addr = info.row.original.address
          const hops = info.row.original.hops
          let used = 0
          let total = 0
          // Per-hop counts for the tooltip breakdown.
          const perHopCounts: Array<{ hop: number; used: number; total: number }> = []
          for (const hop of hops) {
            const node = nodes.get(`${addr}-${hop}`)
            if (node) {
              const hopTotal = node.invitesUsed + node.invitesAvailable
              used += node.invitesUsed
              total += hopTotal
              if (hopTotal > 0) {
                perHopCounts.push({ hop, used: node.invitesUsed, total: hopTotal })
              }
            }
          }
          const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0
          const display = (
            <div className="flex flex-col gap-1.5">
              <span className="text-xs tabular-nums">
                {used}/{total}
              </span>
              {total > 0 && (
                <div className="h-1.5 w-32 overflow-hidden rounded-full bg-muted/30">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-primary via-primary/90 to-primary/65 transition-[width] duration-300"
                    style={{ width: `${pct}%` }}
                  />
                </div>
              )}
            </div>
          )
          // Tooltip only earns its keep when there's per-hop detail to show.
          if (perHopCounts.length <= 1) return display
          return (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="cursor-help">{display}</span>
              </TooltipTrigger>
              <TooltipContent side="top">
                <div className="flex flex-col gap-0.5 text-[11px] tabular-nums">
                  {perHopCounts.map((c) => (
                    <div key={c.hop} className="flex items-center justify-between gap-3">
                      <span>Hop {c.hop}</span>
                      <span>
                        {c.used}/{c.total}
                      </span>
                    </div>
                  ))}
                </div>
              </TooltipContent>
            </Tooltip>
          )
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
            return (
              <span className="tabular-nums">
                {val !== null ? formatArm(val) : '—'}
              </span>
            )
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

    // Always-last "Actions" column. Renders the per-row "⋯" menu (or
    // nothing for the synthetic Armada root).
    cols.push(
      columnHelper.display({
        id: 'actions',
        header: () => <span className="block text-right">Actions</span>,
        cell: (info) => {
          const addr = info.row.original.address
          if (addr === 'armada') return null
          return (
            <div className="flex justify-end">
              <RowActions
                address={addr}
                explorerUrl={explorerUrl}
                onFocusInTree={onFocusInTree}
              />
            </div>
          )
        },
      }),
    )

    return cols
  }, [
    phase,
    resolveENS,
    nodes,
    handleInviterClick,
    connectedAddress,
    explorerUrl,
    onFocusInTree,
  ])

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
      pagination,
    },
    onSortingChange: setSorting,
    onExpandedChange: setExpanded,
    onPaginationChange: setPagination,
    getRowCanExpand: () => true,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
  })

  // Base columns: address, hops, committed, invited-by, invites (5).
  // Phase 1 adds: allocated, claimed (+2). Always-on: actions (+1).
  const colCount = phase === 1 ? 8 : 6

  function handleRowClick(row: Row<AddressSummary>) {
    const addr = row.original.address
    const isSelected = selectedAddress === addr
    onSelectAddress(isSelected ? null : addr)
    row.toggleExpanded()
  }

  return (
    // 300ms delay so tooltips don't fire instantly while scanning rows.
    <TooltipProvider delayDuration={300}>
    <div
      className={cn(
        // Soft elevated container — wraps filters + table + row count.
        // Same recipe as the stepper / stats cards: translucent card surface
        // over the body radial gradient, 1px inset highlight via
        // shadow-elevated, subtle backdrop blur.
        'rounded-xl border border-border/60 bg-card/80 backdrop-blur-sm shadow-elevated',
        'space-y-3 p-4',
      )}
    >
      {/* Header row: title + optional search + hop filter pills.
          When the host wires `onSearchQueryChange`, the search input lives
          inline (matching the mockup); otherwise just title + pills show. */}
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-base font-medium text-foreground">Participants</span>
        {onSearchQueryChange && (
          <SearchBar
            value={searchQuery}
            onChange={onSearchQueryChange}
            className="min-w-[200px] flex-1 sm:max-w-sm"
          />
        )}
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <FilterPill active={hopFilter === null} onClick={() => setHopFilter(null)}>
            All
          </FilterPill>
          {[0, 1, 2].map((hop) => (
            <FilterPill
              key={hop}
              active={hopFilter === hop}
              onClick={() => setHopFilter(hop === hopFilter ? null : hop)}
            >
              Hop {hop}
            </FilterPill>
          ))}
          <FilterPill
            active={multiHopOnly}
            onClick={() => setMultiHopOnly(!multiHopOnly)}
          >
            Multi-hop
          </FilterPill>
          {oversubscribedHops.size > 0 && (
            <FilterPill
              active={oversubOnly}
              onClick={() => setOversubOnly(!oversubOnly)}
            >
              Oversubscribed
            </FilterPill>
          )}
        </div>
      </div>

      {/* Table — sits inside the outer card; rounding masks the thead bg
          while the outer card now provides the visible edge. */}
      <div className="overflow-hidden rounded-lg">
        <table className="w-full text-sm">
          <thead>
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <th
                    key={header.id}
                    style={columnWidthStyle(header.column.id)}
                    className={cn(
                      // Lighter, more product-UI header — no bg fill, subtle
                      // letter-spacing. The first body row's border-t
                      // provides the divider between header and body.
                      'px-4 py-2 text-left text-xs font-medium tracking-wide text-muted-foreground',
                      header.column.getCanSort() &&
                        'cursor-pointer select-none hover:text-foreground',
                    )}
                    onClick={header.column.getToggleSortingHandler()}
                  >
                    <span className="inline-flex items-center gap-1">
                      {flexRender(header.column.columnDef.header, header.getContext())}
                      {(() => {
                        // Sort indicator: always present on sortable columns
                        // so users can see the affordance. Active = full
                        // opacity foreground, inactive = faint placeholder.
                        if (!header.column.getCanSort()) return null
                        const sortState = header.column.getIsSorted()
                        if (sortState === 'asc') {
                          return <ChevronUp className="size-3 text-foreground" />
                        }
                        if (sortState === 'desc') {
                          return <ChevronDown className="size-3 text-foreground" />
                        }
                        return (
                          <ChevronsUpDown className="size-3 opacity-40 group-hover:opacity-60" />
                        )
                      })()}
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
                    className={cn(
                      'group h-16 border-t border-border/60 cursor-pointer transition-colors duration-200 animate-row-enter',
                      // State priority: selected > connected > externally-hovered > default.
                      isSelected
                        ? 'bg-gradient-to-r from-primary/20 via-primary/5 via-[40%] to-transparent border-l-2 border-l-primary'
                        : isConnected
                          ? // Teal tint with a bright-yellow left rail —
                            // matches the connected-node accent in TreeView
                            // (node outline + glow + icon all use the
                            // shared --accent-you token).
                            'bg-hop-connected/10 border-l-2 border-l-accent-you'
                          : isHovered
                            ? 'bg-muted/15'
                            : 'hover:bg-muted/40',
                    )}
                    onClick={() => handleRowClick(row)}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <td key={cell.id} className="px-4 py-2">
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    ))}
                  </tr>
                  {row.getIsExpanded() && (
                    <tr>
                      <td colSpan={colCount} className="px-4 py-3 bg-muted/20">
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
                  <tr
                    key={`skeleton-${i}`}
                    className="h-16 border-b border-border/40 opacity-25"
                  >
                    {Array.from({ length: colCount }).map((_, j) => (
                      <td key={j} className="px-4 py-3">
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

      {/* Footer: count + pagination */}
      {(() => {
        const totalRows = table.getFilteredRowModel().rows.length
        const pageState = table.getState().pagination
        const from =
          totalRows === 0 ? 0 : pageState.pageIndex * pageState.pageSize + 1
        const to = Math.min(
          (pageState.pageIndex + 1) * pageState.pageSize,
          totalRows,
        )
        const pageCount = table.getPageCount()
        const items = pageWindow(pageState.pageIndex + 1, pageCount)
        return (
          <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground tabular-nums">
            <span>
              {totalRows === 0 ? (
                searchQuery ? (
                  <>No participants matching "{searchQuery}"</>
                ) : (
                  <>No participants yet</>
                )
              ) : (
                <>
                  Showing {from} to {to} of {totalRows} participant
                  {totalRows !== 1 ? 's' : ''}
                  {searchQuery && ` matching "${searchQuery}"`}
                </>
              )}
            </span>
            {pageCount > 1 && (
              <div className="flex items-center gap-1">
                <PageButton
                  ariaLabel="Previous page"
                  disabled={!table.getCanPreviousPage()}
                  onClick={() => table.previousPage()}
                >
                  <ChevronLeft className="size-3.5" />
                </PageButton>
                {items.map((p, i) =>
                  p === 'gap' ? (
                    <span
                      key={`gap-${i}`}
                      aria-hidden="true"
                      className="px-1 text-muted-foreground/60"
                    >
                      …
                    </span>
                  ) : (
                    <PageButton
                      key={p}
                      ariaLabel={`Page ${p}`}
                      ariaCurrent={p === pageState.pageIndex + 1}
                      active={p === pageState.pageIndex + 1}
                      onClick={() => table.setPageIndex(p - 1)}
                    >
                      {p}
                    </PageButton>
                  ),
                )}
                <PageButton
                  ariaLabel="Next page"
                  disabled={!table.getCanNextPage()}
                  onClick={() => table.nextPage()}
                >
                  <ChevronRight className="size-3.5" />
                </PageButton>
              </div>
            )}
          </div>
        )
      })()}
    </div>
    </TooltipProvider>
  )
}
