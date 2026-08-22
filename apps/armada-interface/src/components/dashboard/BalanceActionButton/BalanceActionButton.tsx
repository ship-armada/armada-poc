// ABOUTME: Balance-card action button — circular or compact glyph tile with a label, in primary/subtle variants.
// ABOUTME: Ported from the armada-app design mockup.
import type { ReactNode } from 'react'
import styles from './BalanceActionButton.module.css'

export type BalanceActionButtonVariant = 'primary' | 'subtle'
export type BalanceActionButtonLayout = 'circle' | 'compact'
export type BalanceActionButtonSurface = 'frost' | 'tint'

export interface BalanceActionButtonProps {
  label: string
  icon: ReactNode
  variant?: BalanceActionButtonVariant
  layout?: BalanceActionButtonLayout
  /** `frost` on the dashboard wash; `tint` on opaque panels (lavender in light, frost in dark). */
  surface?: BalanceActionButtonSurface
  onClick?: () => void
  disabled?: boolean
  className?: string
  testingClickId?: string
}

export function BalanceActionButton({
  label,
  icon,
  variant = 'subtle',
  layout = 'circle',
  surface = 'frost',
  onClick,
  disabled = false,
  className,
  testingClickId,
}: BalanceActionButtonProps) {
  const classNames = [
    styles.button,
    styles[variant],
    styles[layout],
    surface === 'tint' ? styles.tint : '',
    className,
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <button
      type="button"
      className={classNames}
      onClick={onClick}
      disabled={disabled}
      {...(testingClickId ? { 'data-testing-click': testingClickId } : {})}
    >
      <span className={styles.glyph} aria-hidden>
        {icon}
      </span>
      <span className={`armada-text-ui-label-md ${styles.label}`}>{label}</span>
    </button>
  )
}
