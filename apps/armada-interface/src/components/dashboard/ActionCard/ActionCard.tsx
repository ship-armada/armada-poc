// ABOUTME: Dashboard action tile — title + directional arrow icon top-right + subtitle, with an optional footer slot.
// ABOUTME: Caller wires onClick to setOpenModal(...) at the Dashboard level; this component is dumb chrome.

import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import styles from './ActionCard.module.css'

export interface ActionCardProps {
  icon: LucideIcon
  title: string
  subtitle: string
  /**
   * Optional row anchored to the bottom of the card — used by the Earn card to surface the
   * "Earning in vault — {amount}" stat. When `progress` is also supplied, the row sits below
   * the progress bar; otherwise it sits alone with a thin top divider.
   */
  footer?: ReactNode
  /**
   * 0–100 fill percentage for the bottom progress bar (Earn card uses this for the
   * vault-share-of-total ratio). Values outside [0,100] are clamped. Omit to keep the
   * footer divider rendering instead.
   */
  progress?: number
  onClick: () => void
  disabled?: boolean
  className?: string
}

export function ActionCard({
  icon: Icon,
  title,
  subtitle,
  footer,
  progress,
  onClick,
  disabled,
  className,
}: ActionCardProps) {
  const cls = [styles.card, disabled ? styles.disabled : '', className].filter(Boolean).join(' ')
  const hasProgress = progress !== undefined
  const fillPct = hasProgress ? Math.max(0, Math.min(100, progress)) : 0
  const footerCls = [styles.footer, hasProgress ? styles.footerNoDivider : ''].filter(Boolean).join(' ')
  return (
    <button
      type="button"
      className={cls}
      onClick={onClick}
      disabled={disabled}
      aria-label={title}
    >
      <div className={styles.body}>
        <div className={styles.text}>
          <span className={styles.title}>{title}</span>
          <span className={styles.subtitle}>{subtitle}</span>
        </div>
        <span className={styles.icon} aria-hidden="true">
          {/* Hard-coded px on Icon — the visual brief is "about half the card height including
              padding" (≈100px cards → ≈48px arrow). Lucide's `size` doesn't pick this up from
              CSS, so the value lives here. Stroke width relaxed so the larger glyph reads
              elegantly rather than chunky. */}
          <Icon size={48} strokeWidth={1.25} />
        </span>
      </div>
      {hasProgress ? (
        <div
          className={styles.progressBar}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(fillPct)}
        >
          <div className={styles.progressFill} style={{ width: `${fillPct}%` }} />
        </div>
      ) : null}
      {footer ? <div className={footerCls}>{footer}</div> : null}
    </button>
  )
}
