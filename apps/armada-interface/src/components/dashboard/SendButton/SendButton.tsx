// ABOUTME: Labeled action button (SEND/REQUEST) with gradient/solid/lavender variants and trailing icon.
// ABOUTME: Ported from the armada-app design mockup.
import { ArrowRightIcon } from '@heroicons/react/24/outline'
import type { ReactNode } from 'react'
import styles from './SendButton.module.css'

export type SendButtonVariant = 'gradient' | 'solid' | 'lavender'

export interface SendButtonProps {
  variant: SendButtonVariant
  label?: string
  icon?: ReactNode
  onClick?: () => void
  disabled?: boolean
  className?: string
  /** Stable id for research click logging (data-testing-click). */
  testingClickId?: string
}

export function SendButton({
  variant,
  label = 'SEND',
  icon,
  onClick,
  disabled = false,
  className,
  testingClickId,
}: SendButtonProps) {
  const classNames = [styles.button, styles[variant], className].filter(Boolean).join(' ')

  return (
    <button
      type="button"
      className={classNames}
      onClick={onClick}
      disabled={disabled}
      {...(testingClickId ? { 'data-testing-click': testingClickId } : {})}
    >
      <span className={styles.label}>{label}</span>
      <span className={styles.icon} aria-hidden>
        {icon ?? <ArrowRightIcon className={styles.arrowIcon} strokeWidth={1.5} />}
      </span>
    </button>
  )
}
