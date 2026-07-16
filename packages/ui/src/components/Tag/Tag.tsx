// ABOUTME: Pill tag with optional status dot (active/warning/error/neutral/lavender) or a custom dot color.
// ABOUTME: Ported from the armada-crowdfund mockup; adds optional `dotColor` override so callers can route hop-specific palette colors through without a new variant per hop.

import type { CSSProperties, ReactNode } from 'react'
import styles from './Tag.module.css'

export type TagDot = 'active' | 'warning' | 'error' | 'neutral' | 'lavender'

export interface TagProps {
  /** Pill body. String values render verbatim (the original mockup signature);
   *  `ReactNode` is accepted so callers can compose multi-style labels —
   *  e.g. a hop chip with a smaller multiplier suffix. */
  label: ReactNode
  dot?: TagDot
  /** When supplied, overrides the `dot` variant's color with an arbitrary
   *  CSS color (hex / rgb / token reference). Renders the dot even when
   *  `dot` is omitted. Used by the crowdfund MyPosition meta row to color
   *  hop chips from the canonical hop palette (`graphHopColors.ts`). */
  dotColor?: string
  className?: string
}

export function Tag({ label, dot, dotColor, className }: TagProps) {
  const showDot = !!dot || !!dotColor
  const dotStyle: CSSProperties | undefined = dotColor ? { background: dotColor } : undefined
  return (
    <span className={[styles.tag, className].filter(Boolean).join(' ')}>
      {showDot && (
        <span
          className={[styles.dot, dot ? styles[dot] : ''].filter(Boolean).join(' ')}
          style={dotStyle}
        />
      )}
      {label}
    </span>
  )
}
