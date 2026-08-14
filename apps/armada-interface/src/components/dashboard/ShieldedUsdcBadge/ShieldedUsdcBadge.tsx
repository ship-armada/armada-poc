// ABOUTME: Branded USDC token badge with a gradient shield overlay marking shielded balances.
// ABOUTME: Ported from the armada-app design mockup.
import { useId } from 'react'
import TokenUSDC from '@web3icons/react/icons/tokens/TokenUSDC'
import styles from './ShieldedUsdcBadge.module.css'

const SHIELD_ICON_PATH =
  'M11.484 2.17a.75.75 0 011.032 0 11.209 11.209 0 007.877 3.08.75.75 0 01.722.515 12.74 12.74 0 01.635 3.985c0 5.942-4.064 10.933-9.563 12.348a.75.75 0 01-.374 0C6.314 20.683 2.25 15.692 2.25 9.75c0-1.39.203-2.73.635-3.985a.75.75 0 01.722-.515 11.209 11.209 0 007.877-3.08z'

export interface ShieldedUsdcBadgeProps {
  /** Outer badge edge length in px — matches BalanceCard brand badge (36px default). */
  size?: number
  className?: string
}

function GradientShieldIcon({ className }: { className?: string }) {
  const gradientId = useId().replace(/:/g, '')

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      className={className}
      aria-hidden
    >
      <defs>
        <linearGradient id={gradientId} x1="12" y1="2" x2="12" y2="22" gradientUnits="userSpaceOnUse">
          <stop stopColor="var(--semantic-component-button-gradient-default-from)" />
          <stop offset="1" stopColor="var(--semantic-component-button-gradient-default-to)" />
        </linearGradient>
      </defs>
      <path
        className={styles.shieldPath}
        fill={`url(#${gradientId})`}
        fillRule="evenodd"
        d={SHIELD_ICON_PATH}
        clipRule="evenodd"
      />
    </svg>
  )
}

export function ShieldedUsdcBadge({ size = 36, className }: ShieldedUsdcBadgeProps) {
  /** @web3icons branded assets use an 18px circle in a 24px viewBox. */
  const iconSize = Math.round((size * 24) / 18)
  const rootClassName = [styles.root, className].filter(Boolean).join(' ')

  return (
    <span
      className={rootClassName}
      style={{ '--shielded-usdc-badge-size': `${size}px` } as React.CSSProperties}
      aria-hidden
    >
      <TokenUSDC size={iconSize} variant="branded" className={styles.tokenGlyph} />
      <span className={styles.shieldOverlay}>
        <GradientShieldIcon className={styles.shieldIcon} />
      </span>
    </span>
  )
}
