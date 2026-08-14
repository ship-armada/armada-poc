// ABOUTME: Branded USDC token badge (circular icon in a square frame).
// ABOUTME: Ported from the armada-app design mockup.
import TokenUSDC from '@web3icons/react/icons/tokens/TokenUSDC'
import styles from './TokenBadge.module.css'

export interface TokenBadgeProps {
  /** Outer badge square edge length in px. */
  size?: number
  className?: string
}

/** Branded USDC token badge (circular icon in a square frame). */
export function TokenBadge({ size = 40, className }: TokenBadgeProps) {
  /** @web3icons branded assets use an 18px circle in a 24px viewBox. */
  const iconSize = Math.round((size * 24) / 18)
  const classNames = [styles.badge, className].filter(Boolean).join(' ')

  return (
    <div
      className={classNames}
      style={{ width: size, height: size }}
      aria-hidden
    >
      <TokenUSDC size={iconSize} variant="branded" className={styles.icon} />
    </div>
  )
}
