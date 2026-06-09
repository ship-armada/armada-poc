// ABOUTME: Pill-shaped button primitive with primary/secondary/ghost/gradient variants and three sizes.
// ABOUTME: Ported byte-identical from the armada-crowdfund mockup; restyle via tokens, not edits here.

import type { ReactNode } from 'react'
import styles from './Button.module.css'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'gradient'
export type ButtonSize = 'sm' | 'md' | 'lg'

export interface ButtonProps {
  variant?: ButtonVariant
  size?: ButtonSize
  label?: string
  showIcon?: boolean
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

const Arrow = () => (
  <svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" width="100%" height="100%">
    <path d="M2 8H14M10 4L14 8L10 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
)

export function Button({
  variant = 'primary',
  size = 'md',
  label = 'Button',
  showIcon = true,
  disabled = false,
  loading = false,
  onClick,
  className,
  type = 'button',
  style,
  leadingIcon,
}: ButtonProps) {
  const showTrailing = showIcon || loading
  const cls = [
    styles.btn,
    styles[variant],
    styles[size],
    showTrailing ? styles.icon : '',
    loading ? styles.loading : '',
    leadingIcon ? styles.leading : '',
    className ?? '',
  ].filter(Boolean).join(' ')

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
      {showTrailing ? (
        <span className={styles.iconWrap} aria-hidden={loading}>
          {loading ? <span className={styles.spinner} /> : showIcon ? <Arrow /> : null}
        </span>
      ) : null}
    </button>
  )
}
