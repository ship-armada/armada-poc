// ABOUTME: Compact corner panel explaining the TreeView's visual vocabulary.
// ABOUTME: Hop colours, multi-hop marker, connected-wallet glow, inviter chain.

import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { Button } from './ui/button.js'

export interface GraphLegendProps {
  /** If supplied, legend includes the "your wallet" + "inviter chain" rows. */
  connectedAddress?: string | null
  className?: string
}

/** Small coloured circle swatch matching the TreeView node rendering. */
function Swatch({ color, stroke }: { color?: string; stroke?: string }) {
  return (
    <svg width={14} height={14} aria-hidden>
      <circle
        cx={7}
        cy={7}
        r={5.5}
        style={{ fill: color ?? 'none', stroke: stroke ?? color, fillOpacity: color ? 0.6 : 0 }}
        strokeWidth={1.5}
      />
    </svg>
  )
}

/** Multi-hop marker — circle with a dashed outer ring (matches the
 *  TreeView's multi-hop rendering, which draws a dashed
 *  `--hop-multi` stroke at r+3 around the node). */
function MultiHopSwatch() {
  return (
    <svg width={14} height={14} aria-hidden>
      <circle
        cx={7}
        cy={7}
        r={3.5}
        style={{ fill: 'var(--hop-0)', stroke: 'var(--hop-0)', fillOpacity: 0.6 }}
        strokeWidth={1.5}
      />
      <circle
        cx={7}
        cy={7}
        r={6}
        fill="none"
        style={{ stroke: 'var(--hop-multi)' }}
        strokeWidth={1}
        strokeDasharray="2 2"
      />
    </svg>
  )
}

export function GraphLegend({ connectedAddress, className }: GraphLegendProps) {
  const [open, setOpen] = useState(true)

  return (
    <div
      className={[
        'absolute top-3 left-3 z-10 rounded-md border border-border bg-card/80 backdrop-blur-sm shadow-sm text-xs',
        className ?? '',
      ].join(' ')}
    >
      <Button
        variant="ghost"
        size="sm"
        className="h-7 px-2 gap-1 font-normal text-muted-foreground hover:text-foreground"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={open ? 'Collapse legend' : 'Expand legend'}
      >
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        Legend
      </Button>
      {open && (
        <div className="px-3 pb-2 space-y-1.5">
          <div className="flex items-center gap-2">
            <Swatch color="var(--hop-0)" />
            <span className="text-muted-foreground">Hop 0</span>
          </div>
          <div className="flex items-center gap-2">
            <Swatch color="var(--hop-1)" />
            <span className="text-muted-foreground">Hop 1</span>
          </div>
          <div className="flex items-center gap-2">
            <Swatch color="var(--hop-2)" />
            <span className="text-muted-foreground">Hop 2</span>
          </div>
          <div className="flex items-center gap-2">
            <MultiHopSwatch />
            <span className="text-muted-foreground">Multi-hop</span>
          </div>
          {connectedAddress && (
            <div className="flex items-center gap-2">
              <Swatch stroke="var(--hop-connected)" />
              <span className="text-muted-foreground">Your wallet</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
