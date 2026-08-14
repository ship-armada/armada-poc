// ABOUTME: Wallet button — pill with gradient (amber→lavender) border, round avatar, and label.
// ABOUTME: Visual-only; wagmi/RainbowKit/etc. wallet logic stays in the consuming app.

import type { ReactNode } from 'react'
import styles from './WalletButton.module.css'

export type WalletButtonVariant = 'default' | 'destructive'

export interface WalletButtonProps {
  /** Wallet address or label shown on the right (e.g. "0x63c2…84c6", "Connect Wallet"). */
  label: string
  /** Custom avatar element rendered in the left circle. Defaults to the brand
   *  radial-gradient circle that ships with the mockup. */
  icon?: ReactNode
  onClick?: () => void
  /** Accessible label for the whole button. Defaults to "Wallet". */
  ariaLabel?: string
  /** When true, the button is non-interactive (opacity dim + cursor: not-allowed).
   *  Useful for transient states like wallet-stack hydration. Not in the mockup. */
  disabled?: boolean
  /** "default" = brand gradient border (mockup-as-shipped).
   *  "destructive" = solid status.error border + tint, for urgent states
   *  like wrong-network. Not in the mockup. */
  variant?: WalletButtonVariant
  className?: string
}

export function WalletButton({
  label,
  icon,
  onClick,
  ariaLabel = 'Wallet',
  disabled = false,
  variant = 'default',
  className,
}: WalletButtonProps) {
  return (
    <button
      type="button"
      className={[styles.btn, styles[variant], className].filter(Boolean).join(' ')}
      onClick={onClick}
      aria-label={ariaLabel}
      disabled={disabled}
    >
      <span className={styles.icon} aria-hidden>
        {icon}
      </span>
      <span className={styles.text}>{label}</span>
    </button>
  )
}
