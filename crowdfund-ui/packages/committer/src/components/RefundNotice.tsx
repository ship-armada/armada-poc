// ABOUTME: First-sale (Sale 1) refund notices: a pre-launch line linking to /refund, and a live banner for eligible wallets.
// ABOUTME: Both only link to the /refund page, which owns the claim; neither sends a transaction itself.

import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { formatUsdc } from '@armada/crowdfund-shared'
import { getRefundOnlyCrowdfundAddress } from '@/config/refundOnly'
import { useRefundOnlyClaim } from '@/hooks/useRefundOnlyClaim'
import styles from './RefundNotice.module.css'

function Notice({ children, linkLabel }: { children: ReactNode; linkLabel: string }) {
  return (
    <aside className={styles.notice} aria-label="First-sale refund">
      <span className={styles.text}>{children}</span>
      <Link to="/refund" className={styles.link}>
        {linkLabel} →
      </Link>
    </aside>
  )
}

/** Pre-launch countdown line. No wallet is connected there, so it shows to everyone while the
 *  network has a first sale to refund. */
export function PrelaunchRefundNotice() {
  if (!getRefundOnlyCrowdfundAddress()) return null
  return <Notice linkLabel="Claim your refund">Committed to the first Armada sale?</Notice>
}

/** Live-app banner, shown only to a connected wallet with a first-sale refund waiting. */
export function EligibleRefundNotice({
  walletAddress,
  activeCrowdfundAddress,
}: {
  walletAddress: string | null
  /** The live sale's crowdfund; the banner never points users at the sale they are looking at. */
  activeCrowdfundAddress: string | null
}) {
  const { crowdfundAddress, state } = useRefundOnlyClaim(walletAddress)
  if (!crowdfundAddress || state?.kind !== 'eligible') return null
  if (activeCrowdfundAddress && activeCrowdfundAddress.toLowerCase() === crowdfundAddress.toLowerCase()) {
    return null
  }
  return (
    <Notice linkLabel="Claim refund">
      You still have {formatUsdc(state.amount)} USDC to claim back from the first Armada sale.
    </Notice>
  )
}
