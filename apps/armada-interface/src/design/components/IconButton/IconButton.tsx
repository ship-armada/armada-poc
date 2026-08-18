// ABOUTME: Square icon button with solid/gradient/ghost/secondary variants for dashboard controls.
// ABOUTME: Ported from the armada-app design mockup.
import { forwardRef, type ReactNode } from 'react'
import styles from './IconButton.module.css'

export type IconButtonVariant = 'solid' | 'gradient' | 'ghost' | 'secondary' | 'frosted'
export type IconButtonSize = 'sm' | 'md' | 'lg'

export interface IconButtonProps {
  variant: IconButtonVariant
  /** Hit-target size. Icon stays 24px on every size. Default `lg` (56px). */
  size?: IconButtonSize
  icon: ReactNode
  active?: boolean
  onClick?: () => void
  disabled?: boolean
  className?: string
  iconClassName?: string
  'aria-label': string
  /** Stable id for research click logging (data-testing-click). */
  testingClickId?: string
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  {
    variant,
    size = 'lg',
    icon,
    active = false,
    onClick,
    disabled = false,
    className,
    iconClassName,
    'aria-label': ariaLabel,
    testingClickId,
  },
  ref,
) {
  const sizeClass =
    size === 'sm' ? styles.sizeSm : size === 'md' ? styles.sizeMd : styles.sizeLg

  const classNames = [
    styles.button,
    sizeClass,
    styles[variant],
    variant === 'ghost' && active ? styles.ghostActive : '',
    className,
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <button
      ref={ref}
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
})
