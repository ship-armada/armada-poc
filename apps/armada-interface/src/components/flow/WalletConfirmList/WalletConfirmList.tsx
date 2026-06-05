// ABOUTME: Step-4-style wallet action list — spinner / pending circle / check per row inside a raised card.

import styles from './WalletConfirmList.module.css'
import type { WalletStep, WalletStepStatus } from '@/lib/tx/shieldWalletSteps'

const STATUS_LABEL: Record<WalletStepStatus, string> = {
  loading: 'Loading',
  pending: 'Pending',
  done: 'Complete',
}

export interface WalletConfirmListProps {
  steps: WalletStep[]
}

export function WalletConfirmList({ steps }: WalletConfirmListProps) {
  return (
    <div
      className={styles.card}
      role="list"
      aria-live="polite"
      aria-label="Wallet confirmations"
    >
      {steps.map((step, i) => (
        <div key={step.label} role="listitem">
          {i > 0 ? <div className={styles.divider} aria-hidden="true" /> : null}
          <div className={styles.row}>
            <span className={styles.label}>{step.label}</span>
            <div className={styles.status} aria-label={STATUS_LABEL[step.status]}>
              {step.status === 'loading' ? (
                <div className={styles.spinner} role="status" aria-label="Loading" />
              ) : null}
              {step.status === 'pending' ? (
                <div className={styles.circle} aria-hidden="true" />
              ) : null}
              {step.status === 'done' ? (
                <div className={styles.check} aria-hidden="true">
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                    <path
                      d="M2 6L5 9L10 3"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </div>
              ) : null}
              <span className={styles.visuallyHidden}>{STATUS_LABEL[step.status]}</span>
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}
