// ABOUTME: Dashboard action grid — three ActionCards (Pay / Earn / Withdraw). Deposit lives in BalanceHero now.
// ABOUTME: Disconnected clicks open RainbowKit connect; the chosen flow opens after connect.

import { ArrowDown, ArrowRight, ArrowUpRight } from 'lucide-react'
import { useAtomValue } from 'jotai'
import { syncStateAtom } from '@/state/wallet'
import { useOpenActionModal } from '@/hooks/useOpenActionModal'
import { useBalances } from '@/hooks/useBalances'
import { useYieldRate } from '@/hooks/useYieldRate'
import { sharesToUsdc } from '@/lib/yield'
import { formatUsdcAmount } from '@/lib/format'
import { ActionCard } from '../ActionCard'
import styles from './ActionGrid.module.css'

export function ActionGrid() {
  const openActionModal = useOpenActionModal()
  // Earn card footer surfaces the user's current vault balance. Falls back to "—" when either
  // the shielded balance scan or the vault rate hasn't returned yet — the alternative ("0")
  // would mis-read as "you have nothing in vault" rather than "we're still loading".
  const { shielded, yieldShares } = useBalances()
  const { rate } = useYieldRate()
  const sync = useAtomValue(syncStateAtom)
  const syncing = sync.status === 'syncing' || sync.status === 'failed'
  const earningUsdc =
    yieldShares !== null && rate !== null ? sharesToUsdc(yieldShares, rate.rate) : null
  const earningLabel = earningUsdc === null ? '—' : formatUsdcAmount(earningUsdc, { decimals: 4 })
  // Vault share of total private USDC for the Earn card progress bar. Total = shielded + vault,
  // matching BalanceHero's definition. Stays at 0% until both numbers have resolved; if total is
  // zero we report 0 to avoid divide-by-zero (NaN would render the bar full). While the Railgun
  // engine is still syncing, force 0 so the bar reads as "no data yet" instead of a stale figure.
  //
  // Dust handling: anything below the Earn footer's 4-decimal display threshold (50 raw units =
  // 0.00005 USDC) rounds to "0.0000" in the UI. Without rounding to that floor here, a few raw
  // share units in the vault paired with 0n shielded would compute as 100% and fill the bar even
  // though the user reads both balances as zero. Treat sub-threshold amounts as 0 on each side
  // before computing the ratio so the bar matches the displayed numbers.
  const earnProgress = (() => {
    if (syncing) return 0
    if (earningUsdc === null || shielded === null) return 0
    const DUST = 50n
    const vault = earningUsdc < DUST ? 0n : earningUsdc
    const avail = shielded < DUST ? 0n : shielded
    const total = avail + vault
    if (total === 0n) return 0
    return Number((vault * 10_000n) / total) / 100
  })()

  return (
    <div className={styles.grid} role="group" aria-label="Account actions">
      <ActionCard
        icon={ArrowRight}
        title="Pay"
        subtitle="Send privately or to a wallet"
        onClick={() => openActionModal('payment')}
      />
      <ActionCard
        icon={ArrowUpRight}
        title="Earn"
        subtitle="Move into the savings vault"
        onClick={() => openActionModal('yield-deposit')}
        progress={earnProgress}
        footer={
          syncing ? (
            <span className={styles.earnFooterLabel}>Syncing…</span>
          ) : (
            <>
              <span className={styles.earnFooterLabel}>Earning in vault</span>
              <span className={styles.earnFooterValue}>{earningLabel}</span>
            </>
          )
        }
      />
      <ActionCard
        icon={ArrowDown}
        title="Withdraw"
        subtitle="Send to your wallet"
        onClick={() => openActionModal('unshield')}
      />
    </div>
  )
}
