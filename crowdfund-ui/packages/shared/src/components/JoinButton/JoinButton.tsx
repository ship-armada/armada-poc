// ABOUTME: Circular gradient "Join now" CTA that expands to a pill on hover/expanded state.
// ABOUTME: Ported byte-identical from the armada-crowdfund mockup; props interface promoted to `export`.

import { ArrowRightIcon } from '@heroicons/react/24/solid'
import styles from './JoinButton.module.css'

export interface JoinButtonProps {
  onClick: () => void
  /** When true, shows the expanded "Join now" state (e.g. parent card hover). */
  expanded?: boolean
  size?: 'md' | 'lg'
}

export default function JoinButton({ onClick, expanded = false, size = 'md' }: JoinButtonProps) {
  return (
    <button
      className={[
        styles.button,
        size === 'lg' && styles.lg,
        expanded && styles.expanded,
      ]
        .filter(Boolean)
        .join(' ')}
      onClick={onClick}
    >
      <span className={styles.label}>Join now</span>
      <ArrowRightIcon className={styles.icon} />
    </button>
  )
}
