// ABOUTME: Dashboard action grid — four ActionCards (Deposit / Withdraw / Send / Earn).
// ABOUTME: Disconnected clicks open RainbowKit connect; the chosen flow opens after connect.

import { ArrowDownToLine, ArrowUpFromLine, Send, TrendingUp } from 'lucide-react'
import { useOpenActionModal } from '@/hooks/useOpenActionModal'
import { ActionCard } from '../ActionCard'
import styles from './ActionGrid.module.css'

export function ActionGrid() {
  const openActionModal = useOpenActionModal()
  return (
    <div className={styles.grid} role="group" aria-label="Account actions">
      <ActionCard
        icon={ArrowDownToLine}
        title="Deposit"
        subtitle="Move USDC into private balance"
        onClick={() => openActionModal('shield')}
      />
      <ActionCard
        icon={ArrowUpFromLine}
        title="Withdraw"
        subtitle="Send to your wallet"
        onClick={() => openActionModal('unshield')}
      />
      <ActionCard
        icon={Send}
        title="Send"
        subtitle="Pay privately or to a wallet"
        onClick={() => openActionModal('payment')}
      />
      <ActionCard
        icon={TrendingUp}
        title="Earn"
        subtitle="Move into the savings vault"
        onClick={() => openActionModal('yield-deposit')}
      />
    </div>
  )
}
