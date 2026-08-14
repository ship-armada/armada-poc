// ABOUTME: Pill-shaped button primitive with primary/secondary/ghost/gradient variants and three sizes.
// ABOUTME: Ported byte-identical from the armada-crowdfund mockup; restyle via tokens, not edits here.

import type { ReactNode } from 'react'
import { ArrowRightIcon as ArrowRightMicroIcon } from '@heroicons/react/16/solid'
import { ArrowRightIcon } from '@heroicons/react/24/outline'
import styles from './Button.module.css'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'gradient'
export type ButtonSize = 'sm' | 'md' | 'lg'
export type ButtonIcon = 'arrow-right' | 'arrow-right-micro'

export interface ButtonProps {
  variant?: ButtonVariant
  size?: ButtonSize
  label?: string
  showIcon?: boolean
  /** Default `arrow-right`, or `arrow-right-micro` for Participate CTAs (Heroicons 16/solid). */
  icon?: ButtonIcon
  disabled?: boolean
  /** Keeps the default variant colors and shows a spinner (does not apply muted disabled styles). */
  loading?: boolean
  onClick?: () => void
  style?: React.CSSProperties
  className?: string
  type?: 'button' | 'submit' | 'reset'
  /**
   * Optional icon rendered before the label. Mockup buttons are label-only or
   * label + trailing arrow; armada-interface's "Connect Wallet" pill ships with a leading
   * `LogIn` glyph to read as an entry-action button. Same design-system-deviation precedent as
   * `WalletPillMenu.extraSection` and `WalletButton.disabled`. See packages/ui/src/components/CLAUDE.md.
   */
  leadingIcon?: ReactNode
}

const ICON_PX: Record<ButtonSize, number> = { sm: 14, md: 16, lg: 18 }
const MICRO_ICON_PX = 16

function resolveIcon(label: string, icon: ButtonIcon | undefined, showIcon: boolean): ButtonIcon {
  if (!showIcon) return 'arrow-right'
  if (icon) return icon
  if (label.trim().toLowerCase() === 'participate') return 'arrow-right-micro'
  return 'arrow-right'
}

export function Button({
  variant = 'primary',
  size = 'md',
  label = 'Button',
  showIcon = true,
  icon,
  disabled = false,
  loading = false,
  onClick,
  className,
  type = 'button',
  style,
  leadingIcon,
}: ButtonProps) {
  const resolvedIcon = resolveIcon(label, icon, showIcon)
  const iconPx = resolvedIcon === 'arrow-right-micro' ? MICRO_ICON_PX : ICON_PX[size]
  // Loading occupies the trailing slot even when showIcon is false, so the spinner has room.
  const showTrailing = showIcon || loading

  const cls = [
    styles.btn,
    styles[variant],
    styles[size],
    !showTrailing && styles.noIcon,
    loading && styles.loading,
    leadingIcon && styles.leading,
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <button
      type={type}
      className={cls}
      disabled={disabled && !loading}
      aria-busy={loading || undefined}
      onClick={loading ? undefined : onClick}
      style={style}
    >
      {leadingIcon ? (
        <span className={styles.iconWrap} aria-hidden>
          {leadingIcon}
        </span>
      ) : null}
      <span>{label}</span>
      {showTrailing && (
        <span className={styles.iconWrap} aria-hidden={loading}>
          {loading ? (
            <span className={styles.spinner} />
          ) : resolvedIcon === 'arrow-right-micro' ? (
            <ArrowRightMicroIcon className={styles.iconSvg} width={iconPx} height={iconPx} />
          ) : (
            <ArrowRightIcon className={styles.iconSvg} width={iconPx} height={iconPx} />
          )}
        </span>
      )}
    </button>
  )
}
