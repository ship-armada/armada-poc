// ABOUTME: Square icon button with solid/gradient/ghost/secondary variants for dashboard controls.
// ABOUTME: Ported from the armada-app design mockup.
import type { ReactNode } from 'react'
import styles from './IconButton.module.css'

export type IconButtonVariant = 'solid' | 'gradient' | 'ghost' | 'secondary'

export interface IconButtonProps {
  variant: IconButtonVariant
  icon: ReactNode
  active?: boolean
  /** Ghost on a raised white circle (dashboard “more” control). */
  ghostSurface?: boolean
  onClick?: () => void
  disabled?: boolean
  className?: string
  iconClassName?: string
  'aria-label': string
  /** Stable id for research click logging (data-testing-click). */
  testingClickId?: string
}

export function IconButton({
  variant,
  icon,
  active = false,
  ghostSurface = false,
  onClick,
  disabled = false,
  className,
  iconClassName,
  'aria-label': ariaLabel,
  testingClickId,
}: IconButtonProps) {
  const classNames = [
    styles.button,
    styles[variant],
    variant === 'ghost' && ghostSurface ? styles.ghostSurface : '',
    variant === 'ghost' && active ? styles.ghostActive : '',
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
      aria-label={ariaLabel}
      {...(testingClickId ? { 'data-testing-click': testingClickId } : {})}
    >
      <span className={[styles.icon, iconClassName].filter(Boolean).join(' ')} aria-hidden>
        {icon}
      </span>
    </button>
  )
}
