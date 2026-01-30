export type TransactionPhase = 'building' | 'signing' | 'submitting' | null

/**
 * Get user-friendly message for a transaction phase
 */
export function getTransactionPhaseMessage(phase: TransactionPhase): string {
  switch (phase) {
    case 'building':
      return 'Building transaction...'
    case 'signing':
      return 'Waiting for approval...'
    case 'submitting':
      return 'Submitting transaction...'
    default:
      return ''
  }
}

/**
 * Get ARIA label for a transaction phase (for screen readers)
 */
export function getTransactionPhaseAriaLabel(phase: TransactionPhase): string {
  switch (phase) {
    case 'building':
      return 'Building transaction'
    case 'signing':
      return 'Waiting for wallet approval'
    case 'submitting':
      return 'Submitting transaction'
    default:
      return ''
  }
}

