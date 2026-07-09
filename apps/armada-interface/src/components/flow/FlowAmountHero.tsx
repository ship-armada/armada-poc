// ABOUTME: Hero amount + USDC icon row shared by overlay flow review and complete steps.

import TokenUSDC from '@web3icons/react/icons/tokens/TokenUSDC'
import { formatUsdcAmount } from '@/lib/format'
import reviewStyles from '@/components/shield/ShieldReviewStep.module.css'

const USDC_ICON_SIZE = 24

export interface FlowAmountHeroProps {
  amount: bigint
}

export function FlowAmountHero({ amount }: FlowAmountHeroProps) {
  const amountLabel = formatUsdcAmount(amount)

  return (
    <div className={reviewStyles.amountBlock}>
      <span className={reviewStyles.amountValue}>{amountLabel}</span>
      <div className={reviewStyles.currencyRow}>
        <span className={reviewStyles.currencyIcon} aria-hidden>
          <TokenUSDC size={USDC_ICON_SIZE} variant="branded" />
        </span>
        <span className={reviewStyles.currencyLabel}>USDC</span>
      </div>
    </div>
  )
}
