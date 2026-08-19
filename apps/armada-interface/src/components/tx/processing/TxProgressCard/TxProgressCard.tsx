// ABOUTME: In-progress hero card — rotating 60-tick ring around a USDC badge + title/subtitle.
// ABOUTME: Ported from the armada-app design mockup.
import { useMemo, type CSSProperties } from 'react'
import { TokenBadge } from '@/components/dashboard/TokenBadge'
import type { TxProgressCardCopy } from '../processingCopy'
import styles from './TxProgressCard.module.css'

const TICK_COUNT = 60
/** Matches `--primitives-spacing-10` (40px) inside the 80px tick ring. */
const USDC_BADGE_PX = 40

export type TxProgressCardVariant = 'card' | 'immersive'

export interface TxProgressCardProps {
  copy: TxProgressCardCopy
  /** `immersive` = no inset card chrome; used when the shell owns the gradient. */
  variant?: TxProgressCardVariant
  className?: string
}

function ProgressTitle({ copy }: { copy: TxProgressCardCopy }) {
  if (copy.titleLines && copy.titleLines.length > 0) {
    return (
      <p className={styles.title}>
        {copy.titleLines.map((line, index) => (
          <span key={`${index}-${line}`} className={styles.titleLine}>
            {line}
          </span>
        ))}
      </p>
    )
  }

  if (!copy.titleBreakAfter) {
    return <p className={styles.title}>{copy.title}</p>
  }

  const breakIndex = copy.title.indexOf(copy.titleBreakAfter)
  if (breakIndex === -1) {
    return <p className={styles.title}>{copy.title}</p>
  }

  const splitAt = breakIndex + copy.titleBreakAfter.length
  const firstLine = copy.title.slice(0, splitAt).trimEnd()
  const secondLine = copy.title.slice(splitAt).trim()

  return (
    <p className={styles.title}>
      <span className={styles.titleLine}>{firstLine}</span>
      <span className={styles.titleLine}>{secondLine}</span>
    </p>
  )
}

function ProgressSubtitle({ copy }: { copy: TxProgressCardCopy }) {
  const lines = copy.subtitleLines

  if (lines && lines.length > 0) {
    return (
      <p className={styles.subtitle}>
        {lines.map((line) => (
          <span key={line} className={styles.subtitleLine}>
            {line}
          </span>
        ))}
      </p>
    )
  }

  return <p className={styles.subtitle}>{copy.subtitle}</p>
}

export function TxProgressCard({ copy, variant = 'card', className }: TxProgressCardProps) {
  const ticks = useMemo(() => Array.from({ length: TICK_COUNT }, (_, index) => index), [])
  const immersive = variant === 'immersive'

  const cls = [styles.card, immersive && styles.cardImmersive, className].filter(Boolean).join(' ')

  return (
    <section className={cls} aria-label={copy.title}>
      <div className={styles.content}>
        <div className={styles.tickRing} aria-hidden>
          {ticks.map((index) => (
            <span key={index} className={styles.tick} style={{ '--i': index } as CSSProperties} />
          ))}
          <TokenBadge size={USDC_BADGE_PX} className={styles.token} />
        </div>

        <div className={styles.titleBlock}>
          <ProgressTitle copy={copy} />
        </div>

        <ProgressSubtitle copy={copy} />
      </div>
    </section>
  )
}
