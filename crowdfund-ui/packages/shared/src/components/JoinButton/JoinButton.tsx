// ABOUTME: Gradient "Join now" CTA — always shows the expanded label + arrow.
// ABOUTME: Ported from the armada-crowdfund mockup; `expanded` kept for callers.

import { ArrowRightIcon } from '@heroicons/react/24/solid'
import styles from './JoinButton.module.css'

export interface JoinButtonProps {
  onClick: () => void
  /** @deprecated Always shows “Join now”; kept for callers. */
  expanded?: boolean
  size?: 'md' | 'lg'
}

export default function JoinButton({ onClick, size = 'md' }: JoinButtonProps) {
  return (
    <button
      type="button"
      className={[styles.button, size === 'lg' && styles.lg].filter(Boolean).join(' ')}
      onClick={onClick}
    >
      <span className={styles.label}>Join now</span>
      <ArrowRightIcon className={styles.icon} aria-hidden />
    </button>
  )
}
