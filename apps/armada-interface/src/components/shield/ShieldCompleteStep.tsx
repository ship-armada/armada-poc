// ABOUTME: Shield complete step — serif "Deposit confirmed" title, USDC coin + deposited-amount block, and a Done CTA.
// ABOUTME: Mirrors the deposit-confirmed reference (centered serif title + coin/amount block + flush footer).

import TokenUSDC from '@web3icons/react/icons/tokens/TokenUSDC'
import { FlowFooter } from '@/components/flow/FlowFooter'
import { formatUsdcAmount } from '@/lib/format'
import usdcAmount from '@/design/styles/usdcAmount.module.css'
import styles from './ShieldCompleteStep.module.css'

const TOKEN_BADGE_PX = 40
/** @web3icons branded assets use an 18px circle in a 24px viewBox — scale up to fill the badge. */
const TOKEN_ICON_SIZE = Math.round((TOKEN_BADGE_PX * 24) / 18)

export interface ShieldCompleteStepProps {
  /** Net amount deposited (post-fee), raw 6-decimal USDC. */
  netAmount: bigint
  onDone: () => void
}

export function ShieldCompleteStep({ netAmount, onDone }: ShieldCompleteStepProps) {
  return (
    <div className={styles.root}>
      <h1 className={styles.title}>Deposit confirmed</h1>

      <div className={styles.amountRow}>
        <div className={styles.amountGroup}>
          <span className={styles.tokenBadge} aria-hidden="true">
            <TokenUSDC size={TOKEN_ICON_SIZE} variant="branded" className={styles.tokenBadgeIcon} />
          </span>
          <span className={[styles.amountValue, usdcAmount.font].join(' ')}>
            {formatUsdcAmount(netAmount)}
          </span>
        </div>
      </div>

      <FlowFooter
        className={styles.footer}
        primary={{ label: 'Done', onClick: onDone }}
      />
    </div>
  )
}
