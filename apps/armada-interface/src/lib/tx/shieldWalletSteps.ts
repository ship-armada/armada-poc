// ABOUTME: Maps shield / shield-xchain tx records to wallet-confirmation rows (Step 4 participate flow parity).

import { formatUsdcAmount } from '@/lib/format'
import type { TxRecord } from '@/lib/tx/types'

export type WalletStepStatus = 'pending' | 'loading' | 'done'

export interface WalletStep {
  label: string
  status: WalletStepStatus
}

function stepStatus(
  done: boolean,
  active: boolean,
): WalletStepStatus {
  if (done) return 'done'
  if (active) return 'loading'
  return 'pending'
}

type ShieldRecord = TxRecord<'shield'> | TxRecord<'shield-xchain'>

function shieldArtifacts(record: ShieldRecord) {
  return record.artifacts as {
    approveSkipped?: boolean
    approveTxHash?: `0x${string}`
    sourceTxHash?: `0x${string}`
  }
}

/**
 * Wallet prompts for deposit (shield) flows:
 * 1. Approve USDC — optional when allowance is low
 * 2. Submit deposit — on-chain shield / crossChainShield (direct) or relay submit (gasless)
 *
 * The build-proof stage runs silently (ephemeral shieldPrivateKey is generated locally; no
 * wallet prompt) and isn't surfaced as a row. shieldWalletInteractionsComplete() still gates
 * on `stagesCompleted.includes('build-proof')` so downstream consumers know proof inputs are
 * ready.
 */
export function shieldWalletSteps(
  record: ShieldRecord | null,
  amount: bigint,
): WalletStep[] {
  const amountLabel = formatUsdcAmount(amount)
  const artifacts = record ? shieldArtifacts(record) : {}
  const approveSkipped = artifacts.approveSkipped === true
  const approveDone = approveSkipped || Boolean(artifacts.approveTxHash)
  const depositBroadcast = Boolean(artifacts.sourceTxHash)
  const terminalSuccess = record?.executionState === 'completed'

  const onSubmitWallet =
    record?.stage === 'submit-relayer'
    && !terminalSuccess
    && (record.executionState === 'active' || record.executionState === 'waiting')

  const steps: WalletStep[] = []

  if (!approveSkipped) {
    steps.push({
      label: `Approve ${amountLabel} USDC`,
      status: stepStatus(
        approveDone,
        onSubmitWallet && !approveDone,
      ),
    })
  }

  const depositLabel =
    record?.kind === 'shield-xchain'
      ? `Submit ${amountLabel} USDC cross-chain deposit`
      : `Submit ${amountLabel} USDC deposit`

  steps.push({
    label: depositLabel,
    status: stepStatus(
      terminalSuccess,
      approveDone && (onSubmitWallet || (depositBroadcast && !terminalSuccess)),
    ),
  })

  return steps
}

/** True once the user has finished every wallet prompt (sign, optional approve, deposit submit). */
export function shieldWalletInteractionsComplete(
  record: ShieldRecord,
): boolean {
  const authorizeDone = record.stagesCompleted.includes('build-proof')
  const artifacts = shieldArtifacts(record)
  const approveDone =
    artifacts.approveSkipped === true || Boolean(artifacts.approveTxHash)
  return authorizeDone && approveDone && Boolean(artifacts.sourceTxHash)
}
