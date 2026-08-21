// ABOUTME: Activity receipt — reopens a past tx's confirm-step view (same FlowShell chrome + frost card + review summary).
// ABOUTME: Reconstructs the summary props from the record's meta/artifacts (no stored snapshot — chunk 6b decision a); step-bar hidden, CTAs are View-on-explorer + Done.

import { type ReactNode } from 'react'
import { Button, modalStepBodyEnter, modalActionRowEnter } from '@/design'
import { FlowShell } from '@/components/flow/FlowShell'
import { useFlowExit } from '@/components/flow/useFlowExit'
import { DepositReviewSummary } from '@/components/deposit/DepositReviewSummary'
import { TransferReviewSummary } from '@/components/payments/TransferReviewSummary'
import { EarnReviewSummary } from '@/components/yield/EarnReviewSummary'
import { formatUsdcPlain } from '@/lib/format'
import { displayTxHash, txExplorerUrl } from '@/lib/explorer'
import { getChainById, getNetworkConfig } from '@/config/network'
import {
  deriveActivityStatus,
  isWithdrawToSelf,
  type DashboardActivityStatus,
} from '@/components/dashboard/txActivityAdapter'
import { resolveTxErrorCopy, type TxErrorCopy } from '@/lib/tx/errorCopy'
import type { TxRecord } from '@/lib/tx/types'
import styles from './ActivityReceipt.module.css'

export interface ActivityReceiptProps {
  /** The record to show a receipt for; null renders nothing. */
  record: TxRecord | null
  /** Connected EVM wallet — disambiguates an unshield as a withdraw (to self) vs an external send. */
  ownWalletAddress?: string
  open: boolean
  onClose: () => void
}

/** Step-bar labels per originating flow — shown all-confirmed on the receipt (matches the mockup). */
const DEPOSIT_STEPS = ['Amount', 'Review', 'Confirm']
const SEND_STEPS = ['Recipient', 'Amount', 'Review', 'Confirm']

interface ReceiptView {
  /** Header label (matches the originating flow: Deposit / Send / Withdraw / Earn). */
  flowLabel: string
  /** The originating flow's step-bar labels, rendered confirmed (all filled). */
  steps: string[]
  /** In-card title (e.g. "USDC deposit"). */
  title: string
  /** Gross USDC amount (raw 6-decimal) shown in the big-numeral block. */
  amount: bigint
  /** The reused review summary for this kind. */
  summary: ReactNode
  /** Source-chain explorer URL; absent disables "View on explorer". */
  explorerUrl?: string
  /** Outcome bucket — drives the FlowShell status + failure banner. */
  status: DashboardActivityStatus
  /** Category-aware failure copy; null for settled/pending records. */
  errorCopy: TxErrorCopy | null
}

function buildReceiptView(record: TxRecord, ownWalletAddress?: string): ReceiptView {
  const status = deriveActivityStatus(record)
  // Only a settled record has a real confirmation time — omit the "Date and time" summary row for
  // failed/cancelled/unknown so the receipt doesn't imply it confirmed.
  const confirmedAt = status === 'settled' ? record.updatedAt : undefined
  const errorCopy =
    status === 'settled' || status === 'pending'
      ? null
      : resolveTxErrorCopy(record.artifacts.error)
  const explorerUrl = txExplorerUrl(record.walletContext.sourceChainId, displayTxHash(record))

  switch (record.kind) {
    case 'shield':
    case 'shield-xchain': {
      const meta = (record as TxRecord<'shield' | 'shield-xchain'>).meta
      const fee = meta.feeAmount ?? null
      const netAmount = fee ? meta.amount - fee : meta.amount
      return {
        flowLabel: 'Deposit',
        steps: DEPOSIT_STEPS,
        title: 'USDC deposit',
        amount: meta.amount,
        explorerUrl,
        status,
        errorCopy,
        summary: (
          <DepositReviewSummary
            fromChainId={meta.fromChainId}
            amount={meta.amount}
            fee={fee}
            netAmount={netAmount}
            confirmedAt={confirmedAt}
          />
        ),
      }
    }
    case 'transfer-shielded':
    case 'unshield-local':
    case 'unshield-xchain': {
      const meta = (record as TxRecord<'transfer-shielded' | 'unshield-local' | 'unshield-xchain'>)
        .meta
      const fee = meta.broadcasterFeeAmount
      const isPrivate = record.kind === 'transfer-shielded'
      // A public unshield to your own wallet is a withdraw; otherwise (and private 0zk) it's a send.
      const asWithdraw = !isPrivate && isWithdrawToSelf(meta.recipient, ownWalletAddress)
      const networkName =
        record.kind === 'unshield-xchain'
          ? getChainById((record as TxRecord<'unshield-xchain'>).meta.toChainId)?.name
          : record.kind === 'unshield-local'
            ? getNetworkConfig().hub.name
            : undefined
      return {
        flowLabel: asWithdraw ? 'Withdraw' : 'Send',
        steps: SEND_STEPS,
        title: asWithdraw ? 'USDC withdrawal' : 'USDC sent',
        amount: meta.amount,
        explorerUrl,
        status,
        errorCopy,
        summary: (
          <TransferReviewSummary
            recipient={meta.recipient}
            fee={fee}
            totalDeducted={meta.amount + fee}
            variant={asWithdraw ? 'withdraw' : 'send'}
            networkName={networkName}
            confirmedAt={confirmedAt}
          />
        ),
      }
    }
    case 'yield-deposit':
    case 'yield-withdraw': {
      const meta = (record as TxRecord<'yield-deposit' | 'yield-withdraw'>).meta
      const fee = meta.broadcasterFeeAmount
      const tab = record.kind === 'yield-deposit' ? 'add' : 'withdraw'
      const netAmount = tab === 'add' ? meta.amount + fee : meta.amount - fee
      const netLabel = tab === 'add' ? 'Total deducted from balance' : 'Received into private balance'
      return {
        flowLabel: 'Earn',
        steps: DEPOSIT_STEPS,
        title: tab === 'add' ? 'Vault deposit' : 'Vault withdrawal',
        amount: meta.amount,
        explorerUrl,
        status,
        errorCopy,
        summary: (
          // APY row hidden — a historical tx's rate isn't stored, so it can't be shown accurately.
          <EarnReviewSummary
            tab={tab}
            amount={meta.amount}
            rate={null}
            fee={fee}
            netAmount={netAmount}
            netLabel={netLabel}
            confirmedAt={confirmedAt}
            showApy={false}
          />
        ),
      }
    }
    case 'transfer-shielded-received': {
      const meta = (record as TxRecord<'transfer-shielded-received'>).meta
      return {
        flowLabel: 'Received',
        steps: DEPOSIT_STEPS,
        title: 'USDC received',
        amount: meta.amount,
        explorerUrl,
        status,
        errorCopy,
        summary: (
          <TransferReviewSummary
            recipient=""
            fee={null}
            totalDeducted={meta.amount}
            variant="send"
            confirmedAt={confirmedAt}
          />
        ),
      }
    }
  }
}

export function ActivityReceipt({ record, ownWalletAddress, open, onClose }: ActivityReceiptProps) {
  const view = record ? buildReceiptView(record, ownWalletAddress) : null

  // Play the slide-down exit before the parent unmounts us (mockup parity with the flow modals).
  const { exiting, requestClose } = useFlowExit(onClose)

  // Settled → confirmed chrome; a definitive failure/cancel → error chrome; an indeterminate
  // (unknown) or pending outcome stays neutral.
  const shellStatus: 'default' | 'confirmed' | 'error' =
    view?.status === 'settled'
      ? 'confirmed'
      : view?.status === 'failed' || view?.status === 'cancelled'
        ? 'error'
        : 'default'

  return (
    <FlowShell
      open={open && view !== null}
      exiting={exiting}
      onClose={requestClose}
      flowLabel={view?.flowLabel ?? 'Activity'}
      steps={view?.steps ?? DEPOSIT_STEPS}
      currentStep={view?.steps.length ?? DEPOSIT_STEPS.length}
      status={shellStatus}
    >
      {view ? (
        <div className={`${modalStepBodyEnter} ${styles.root}`}>
          <div className={styles.titleBlock}>
            <h1 className={styles.title}>{view.title}</h1>
            <div className={styles.amountRow}>
              <span
                className={[
                  styles.amountValue,
                  view.status === 'failed' && styles.amountValueFailed,
                  view.status === 'cancelled' && styles.amountValueCancelled,
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
                {formatUsdcPlain(view.amount)}
              </span>
            </div>
          </div>

          {view.errorCopy ? (
            <div
              className={[
                styles.statusBanner,
                view.status === 'unknown' ? styles.statusBannerUnknown : styles.statusBannerError,
              ].join(' ')}
              role="status"
            >
              <span className={styles.statusBannerTitle}>{view.errorCopy.title}</span>
              {view.errorCopy.body ? (
                <span className={styles.statusBannerBody}>{view.errorCopy.body}</span>
              ) : null}
            </div>
          ) : null}

          {view.summary}

          <div className={`${modalActionRowEnter} ${styles.buttonRow}`}>
            <Button
              variant="secondary"
              size="lg"
              label="View on explorer"
              showIcon={false}
              className={styles.cancelButton}
              disabled={!view.explorerUrl}
              onClick={() => {
                if (view.explorerUrl) window.open(view.explorerUrl, '_blank', 'noopener,noreferrer')
              }}
            />
            <Button
              variant="primary"
              size="lg"
              label="Done"
              showIcon={false}
              className={styles.confirmButton}
              onClick={requestClose}
            />
          </div>
        </div>
      ) : null}
    </FlowShell>
  )
}
