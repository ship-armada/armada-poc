// ABOUTME: Persistent action-style tooltip shown above the amount field for any amount validation error
// ABOUTME: (over-balance, below-minimum, parse). Ported from the mockup's AmountExceededWarning; composes the @/design action-tooltip styling.

import type { ReactNode } from 'react'
import tooltipStyles from '@/design/components/Tooltip/Tooltip.module.css'
import styles from './AmountFieldWarning.module.css'

export interface AmountFieldWarningProps {
  /** Id wired to the input's `aria-describedby` so the alert is announced. */
  id: string
  /** Whether the tooltip is shown (an error message is present). */
  visible: boolean
  /** The validation message to display. */
  message: string
  /** The amount field the tooltip is positioned above. */
  children: ReactNode
}

export function AmountFieldWarning({ id, visible, message, children }: AmountFieldWarningProps) {
  return (
    <div className={styles.wrapper}>
      {visible ? (
        <div
          id={id}
          className={[tooltipStyles.tooltip, tooltipStyles.action, styles.tooltip].join(' ')}
          role="alert"
        >
          <p className={tooltipStyles.actionText}>{message}</p>
        </div>
      ) : null}
      {children}
    </div>
  )
}
