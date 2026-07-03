// ABOUTME: Builds the approve + multicall TxStep pipeline for the self-fill ("max out") flow.
// ABOUTME: One USDC approve (if needed) followed by a single atomic multicall bundling all self-invites + per-hop commits.

import { Contract, type Signer } from 'ethers'
import {
  CROWDFUND_ABI_FRAGMENTS,
  ERC20_ABI_FRAGMENTS,
  encodeSelfFillCalls,
  formatUsdc,
  type ReceiptLogLike,
  type SelfFillPlan,
} from '@armada/crowdfund-shared'
import { submitWrite } from '@/lib/submitWrite'
import type { TxStep } from '@/hooks/useTxPipeline'

export interface BuildSelfFillStepsParams {
  signer: Signer
  /** The participant's own address — the invitee of every self-invite. */
  selfAddress: string
  plan: SelfFillPlan
  usdcAddress: string
  crowdfundAddress: string
  needsApproval: (amount: bigint) => boolean
  refreshAllowance: () => Promise<void>
  onReceiptLogs?: (logs: readonly ReceiptLogLike[]) => void
}

/**
 * Build the two-step pipeline for a self-fill bundle:
 *   1. Approve `newCommitUsdc` (skipped when allowance already covers it).
 *   2. A single `multicall` that issues every self-invite then every per-hop commit.
 *
 * The whole multicall is atomic — if any sub-call reverts, none of the invites or
 * commits land, so the user can safely retry from a clean slate.
 */
export function buildSelfFillSteps({
  signer,
  selfAddress,
  plan,
  usdcAddress,
  crowdfundAddress,
  needsApproval,
  refreshAllowance,
  onReceiptLogs,
}: BuildSelfFillStepsParams): TxStep[] {
  const steps: TxStep[] = []

  if (needsApproval(plan.newCommitUsdc)) {
    steps.push({
      label: `Approve ${formatUsdc(plan.newCommitUsdc)} USDC`,
      send: () => {
        const usdc = new Contract(usdcAddress, ERC20_ABI_FRAGMENTS, signer)
        return submitWrite(usdc, 'approve', [crowdfundAddress, plan.newCommitUsdc], signer)
      },
      // Re-read allowance so the multicall step's view of approval is real.
      after: refreshAllowance,
    })
  }

  const crowdfund = new Contract(crowdfundAddress, CROWDFUND_ABI_FRAGMENTS, signer)
  const calls = encodeSelfFillCalls(crowdfund.interface, selfAddress, plan)
  steps.push({
    label: `Self-invite & commit · ${plan.totalInvites} invites + ${plan.commits.length} commits`,
    send: () => submitWrite(crowdfund, 'multicall', [calls], signer),
    onReceipt: (logs) => onReceiptLogs?.(logs),
    after: refreshAllowance,
  })

  return steps
}
