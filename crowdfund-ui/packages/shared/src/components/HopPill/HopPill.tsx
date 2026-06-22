// ABOUTME: Hop badge — "Invited as <hop>" pill rendered in tables, cards, and the My Position dashboard.
// ABOUTME: Ported byte-identical from the armada-crowdfund mockup; props interface promoted to `export`.

import type { CSSProperties } from 'react'
import { hopPillDotColor } from '../../lib/graphHopColors.js'
import styles from './HopPill.module.css'

export type HopVariant = 'seed' | 'hop-1' | 'hop-2' | 'multi-hop'

const VARIANT_LABEL: Record<HopVariant, string> = {
  seed: 'SEED',
  'hop-1': 'HOP-1',
  'hop-2': 'HOP-2',
  'multi-hop': 'MULTI-HOP',
}

const DOT_COLOR: Record<HopVariant, string> = {
  seed: hopPillDotColor('seed'),
  'hop-1': hopPillDotColor('hop-1'),
  'hop-2': hopPillDotColor('hop-2'),
  'multi-hop': hopPillDotColor('multi-hop'),
}

export interface HopPillProps {
  variant: HopVariant
  label?: string
  className?: string
}

export default function HopPill({ variant, label = 'Invited as', className }: HopPillProps) {
  const dotStyle: CSSProperties = {
    width: 8,
    height: 8,
    background: DOT_COLOR[variant],
  }

  return (
    <div className={[styles.pill, className].filter(Boolean).join(' ')}>
      <span className={styles.label}>{label}</span>
      <span className={styles.tag}>
        <span className={styles.dot} style={dotStyle} aria-hidden />
        <span className={styles.tagLabel}>{VARIANT_LABEL[variant]}</span>
      </span>
    </div>
  )
}
