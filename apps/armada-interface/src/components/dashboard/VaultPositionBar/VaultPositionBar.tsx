// ABOUTME: Compact vault position row showing shielded vault balance, APR, and accrued earnings.
// ABOUTME: Ported from the armada-app design mockup.
import { useState } from 'react'
import { ChartBarIcon } from '@heroicons/react/24/outline'
import { ChevronRightIcon } from '@heroicons/react/24/outline'
import { BalanceScrambleValue } from '@/components/dashboard/BalanceScrambleValue'
import { RollingBalanceValue } from '@/components/dashboard/RollingBalanceValue'
import { hidePeekEventHandlers } from '@/hooks/useHidePeek'
import { useMobileLayout } from '@/hooks/useMobileLayout'
import {
  DEMO_EARN_APY,
  formatEarnedSoFarAmount,
  formatVaultEarningLabel,
} from '@/components/dashboard/vaultEarnings'
import { formatUsdcAmount } from '@/components/dashboard/dashboardFormat'
import usdcAmount from '@/design/styles/usdcAmount.module.css'
import styles from './VaultPositionBar.module.css'

export interface VaultPositionBarProps {
  balance: number
  apy?: number
  earnedAmount?: number
  vaultRollActive?: boolean
  vaultRollFromValue?: string
  vaultRollTrigger?: number
  /**
   * Backward-compatible reveal flag. Prefer `balanceHidden`; when both are
   * omitted the balance is revealed. Deviation from the mockup, which exposes
   * only `balanceHidden` — kept so existing callers keep compiling.
   */
  balanceRevealed?: boolean
  balanceHidden?: boolean
  /** Keep rendering the last value while the row plays its collapse-out (vault fully withdrawn). */
  keepMounted?: boolean
  onOpen?: () => void
}

export function VaultPositionBar({
  balance,
  apy = DEMO_EARN_APY,
  earnedAmount,
  vaultRollActive = false,
  vaultRollFromValue,
  vaultRollTrigger = 0,
  balanceRevealed: balanceRevealedProp,
  balanceHidden,
  keepMounted = false,
  onOpen,
}: VaultPositionBarProps) {
  const isMobile = useMobileLayout()
  const [peekVault, setPeekVault] = useState(false)
  const effectiveHidden =
    balanceHidden !== undefined
      ? balanceHidden
      : balanceRevealedProp !== undefined
        ? !balanceRevealedProp
        : false
  const balanceRevealed = !effectiveHidden || peekVault

  if (balance <= 0 && !vaultRollActive && !keepMounted) return null

  const formattedBalance = formatUsdcAmount(balance)
  // Real accrued yield isn't computed yet (it needs vault cost-basis tracking). When no explicit
  // earnedAmount is supplied we show an obvious "???" placeholder rather than a realistic-looking
  // estimate that could be mistaken for a wired, real value.
  const formattedEarned =
    earnedAmount !== undefined ? formatEarnedSoFarAmount(earnedAmount) : '???'
  const formattedApy = `${apy.toFixed(1)}%`
  const earningLabel = formatVaultEarningLabel(apy)
  const amountLabel = balanceRevealed ? `${formattedBalance} USDC` : 'Shielded vault balance hidden'
  const earnedLabel = balanceRevealed ? `${formattedEarned} earned` : 'Earned amount hidden'
  const apyLabel = balanceRevealed ? earningLabel : 'APY hidden'
  const peekHandlers = hidePeekEventHandlers(
    effectiveHidden,
    () => setPeekVault(true),
    () => setPeekVault(false),
    isMobile,
  )

  const amountDisplay =
    vaultRollActive && vaultRollFromValue !== undefined && balanceRevealed ? (
      <RollingBalanceValue
        value={formattedBalance}
        enableRoll
        mode="fromValue"
        fromValue={vaultRollFromValue}
        rollTrigger={vaultRollTrigger}
        className={styles.amountRoll}
      />
    ) : (
      <BalanceScrambleValue value={formattedBalance} revealed={balanceRevealed} />
    )

  const content = (
    <>
      <div className={styles.lead}>
        <span className={styles.iconBadge} aria-hidden>
          <ChartBarIcon className={styles.icon} strokeWidth={1.5} />
        </span>
        <div className={styles.info}>
          <span className={[styles.amount, usdcAmount.font].join(' ')} aria-label={amountLabel}>
            {amountDisplay}
            <span className={styles.amountSuffix}>USDC</span>
          </span>
          <span className={styles.apr} aria-label={apyLabel}>
            Earning <BalanceScrambleValue value={formattedApy} revealed={balanceRevealed} /> APR
          </span>
        </div>
      </div>

      <div className={styles.trail}>
        <span
          className={[styles.earned, usdcAmount.font, styles.earnedPositive].join(' ')}
          aria-label={earnedLabel}
        >
          <BalanceScrambleValue value={formattedEarned} revealed={balanceRevealed} />
        </span>
        <ChevronRightIcon className={styles.chevron} strokeWidth={2} aria-hidden />
      </div>
    </>
  )

  if (onOpen) {
    return (
      <button
        type="button"
        className={styles.root}
        aria-label="Manage shielded vault"
        onClick={onOpen}
        {...peekHandlers}
      >
        {content}
      </button>
    )
  }

  return (
    <div className={styles.root} aria-label="Shielded vault position" {...peekHandlers}>
      {content}
    </div>
  )
}
