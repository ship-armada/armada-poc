// ABOUTME: v2 Claim flow page-level controller — ARM claim (with mandatory delegate) + USDC refund, dressed in @armada/ui primitives.
// ABOUTME: Provisional design: no designer mockup exists yet for Claim, so this composes Steps/Button/Tag with v1 ClaimTab behavior. Revisit when the designer ships claim screens.

import { useEffect, useMemo, useState } from 'react'
import { Contract, type Signer, type TransactionResponse, type JsonRpcProvider } from 'ethers'
import {
  Step4Approve,
  type ReceiptLogLike,
  type Step4Transaction,
  CROWDFUND_ABI_FRAGMENTS,
  CROWDFUND_CONSTANTS,
  formatArm,
  formatUsdc,
  formatCountdown,
} from '@armada/crowdfund-shared'
import { Steps, Button as ArmadaButton, Tag } from '@armada/ui'
import { mapRevertToMessage } from '@/lib/revertMessages'
import styles from './ClaimFlowV2.module.css'

type ClaimMode = 'arm' | 'refund'
type FlowStep = 'review' | 'submit' | 'done'

export interface ClaimFlowV2Props {
  walletConnected: boolean
  walletAddress: string | null
  signer: Signer | null
  provider: JsonRpcProvider | null
  crowdfundAddress: string | null
  phase: number
  refundMode: boolean
  blockTimestamp: number
  claimDeadline: number
  totalCommitted: bigint
  windowEnd: number
  cappedDemand: bigint
  claimAvailable: boolean
  claimCountdownSeconds?: number
  onGoToMyPosition: () => void
  onGoToNetwork: () => void
  /** Hook for ingesting the claim/refund tx's receipt logs into the event
   *  store — `Allocated` (claim) / `RefundClaimed` (refund) flip the graph's
   *  per-node state immediately instead of on the next event poll. */
  onReceiptLogs?: (logs: readonly ReceiptLogLike[]) => void
  /** Refresh USDC + ARM balance after the tx confirms so the navbar wallet
   *  badge and MyPosition surface the post-claim state right away. */
  refreshAllowance?: () => Promise<void>
}

const ARM_STEPS = ['Review', 'Submit', 'Done']
const REFUND_STEPS = ['Review', 'Submit', 'Done']

export function ClaimFlowV2(props: ClaimFlowV2Props) {
  const {
    walletConnected,
    walletAddress,
    signer,
    provider,
    crowdfundAddress,
    phase,
    refundMode,
    totalCommitted,
    claimAvailable,
    claimCountdownSeconds,
    onGoToMyPosition,
    onGoToNetwork,
    onReceiptLogs,
    refreshAllowance,
  } = props

  const [delegate, setDelegate] = useState<string>(walletAddress ?? '')
  const [armAmount, setArmAmount] = useState<bigint>(0n)
  const [refundAmount, setRefundAmount] = useState<bigint>(0n)
  const [hasClaimed, setHasClaimed] = useState(false)
  const [loading, setLoading] = useState(true)

  const [step, setStep] = useState<FlowStep>('review')
  const [txs, setTxs] = useState<Step4Transaction[] | null>(null)

  // Decide claim mode based on contract state. Phase 2 (cancelled) → refund.
  // Phase 0 with refundMode (cappedDemand < min) → refund. Otherwise → ARM.
  // This mirrors v1 ClaimTab's mode derivation.
  const mode: ClaimMode = phase === 2 || refundMode ? 'refund' : 'arm'

  // Default delegate to the connected wallet address when it becomes available.
  useEffect(() => {
    if (walletAddress && (delegate === '' || delegate === '0x')) {
      setDelegate(walletAddress)
    }
  }, [walletAddress, delegate])

  // Load allocation + claimed state on mount (and when prerequisites change).
  // Read directly from the contract — same approach as v1 ClaimTab.
  useEffect(() => {
    if (!provider || !crowdfundAddress || !walletAddress || phase < 1) {
      setLoading(false)
      return
    }
    let cancelled = false
    const fetchAllocation = async () => {
      try {
        const contract = new Contract(crowdfundAddress, CROWDFUND_ABI_FRAGMENTS, provider)
        const [allocation, claimed] = await Promise.all([
          contract.computeAllocation(walletAddress) as Promise<[bigint, bigint]>,
          contract.claimed(walletAddress) as Promise<boolean>,
        ])
        if (cancelled) return
        setArmAmount(allocation[0])
        setRefundAmount(allocation[1])
        setHasClaimed(claimed)
      } catch {
        // Non-fatal — keep zero values; UI shows "no allocation" state.
      }
      if (!cancelled) setLoading(false)
    }
    fetchAllocation()
    return () => {
      cancelled = true
    }
  }, [provider, crowdfundAddress, walletAddress, phase])

  // What the user actually gets back.
  const armDisplay = useMemo(() => formatArm(armAmount), [armAmount])
  const refundDisplay = useMemo(
    () => formatUsdc(mode === 'refund' ? totalCommitted : refundAmount),
    [mode, totalCommitted, refundAmount],
  )

  // Submit the claim/refund transaction. Updates `txs` so Step4Approve renders
  // controlled status. Mirrors the v1 ClaimTab pipeline but simplified (single
  // op, no toasts at this layer — toasts can be re-added in 3.3.x).
  const runClaim = async () => {
    if (!signer || !crowdfundAddress) return
    const opLabel = mode === 'arm' ? 'Claim ARM' : 'Claim USDC refund'
    setTxs([{ label: opLabel, status: 'loading' }])

    const setRowStatus = (patch: Partial<Step4Transaction>) =>
      setTxs((prev) => (prev ? [{ ...prev[0], ...patch }] : prev))

    try {
      const crowdfund = new Contract(crowdfundAddress, CROWDFUND_ABI_FRAGMENTS, signer)
      const tx: TransactionResponse =
        mode === 'arm' ? await crowdfund.claim(delegate) : await crowdfund.claimRefund()
      const receipt = await tx.wait()
      if (!receipt || receipt.status === 0) {
        setRowStatus({ status: 'error', errorMessage: 'Transaction reverted' })
        return
      }
      setRowStatus({ status: 'done' })
      setHasClaimed(true)
      // Fast-path the Allocated / RefundClaimed receipt log into the event
      // store and refresh balances — same shape as the commit flow's fix.
      // ethers v6 receipt.logs are structurally compatible with ReceiptLogLike
      // (just the `index` vs `logIndex` field differs); cast through unknown.
      onReceiptLogs?.(receipt.logs as unknown as readonly ReceiptLogLike[])
      void refreshAllowance?.()
      setTimeout(() => setStep('done'), 600)
    } catch (err) {
      setRowStatus({
        status: 'error',
        errorMessage: mapRevertToMessage(err),
        errorDetails: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // ── Gate states ─────────────────────────────────────────────────

  if (!walletConnected) {
    return (
      <CardShell title="Connect your wallet to claim">
        <p className={styles.gateBody}>
          Once the campaign finalizes you'll be able to claim ARM tokens (or a USDC refund) from
          here.
        </p>
      </CardShell>
    )
  }

  if (!claimAvailable) {
    return (
      <CardShell title="Claiming isn't open yet">
        <p className={styles.gateBody}>
          You'll be able to claim ARM tokens (or a USDC refund if the sale ends below the minimum
          raise) from here.
        </p>
        {claimCountdownSeconds !== undefined && claimCountdownSeconds > 0 && (
          <p className={styles.gateBodyFootnote}>
            Estimated:{' '}
            <span className={styles.accent}>{formatCountdown(claimCountdownSeconds)}</span>
          </p>
        )}
        <div className={styles.gateActions}>
          <ArmadaButton
            variant="secondary"
            size="md"
            label="Back to crowdfund"
            showIcon={false}
            onClick={onGoToNetwork}
          />
        </div>
      </CardShell>
    )
  }

  if (loading) {
    return (
      <CardShell title="Loading allocation…">
        <p className={styles.gateBody}>Fetching your share of the sale.</p>
      </CardShell>
    )
  }

  // Already-claimed: short-circuit to the done state. Same surface as a
  // freshly-completed claim so the user always sees a coherent end-of-flow.
  if (hasClaimed) {
    return (
      <DoneScreen
        mode={mode}
        armDisplay={armDisplay}
        refundDisplay={refundDisplay}
        onGoToMyPosition={onGoToMyPosition}
        onGoToNetwork={onGoToNetwork}
        alreadyClaimed
      />
    )
  }

  // Pre-finalize disambiguation: when the commit window has ended but
  // `finalize()` hasn't been called yet, the contract still reports
  // `phase=0` and `refundMode=false`, and `computeAllocation()` returns
  // (0, 0) for everyone (allocations only exist post-finalization). Without
  // this branch the user falls through to the generic "Nothing to claim"
  // copy below, which is misleading when the sale's outcome is already
  // determined (e.g., capped demand fell short of MIN_SALE → everyone gets
  // a USDC refund, but no one can claim it until someone calls finalize()).
  const windowEnded = props.windowEnd > 0 && props.blockTimestamp > props.windowEnd
  const saleBelowMin = props.cappedDemand < CROWDFUND_CONSTANTS.MIN_SALE
  if (phase === 0 && windowEnded) {
    if (saleBelowMin) {
      return (
        <CardShell title="Sale ended below minimum">
          <p className={styles.gateBody}>
            {props.totalCommitted > 0n
              ? `The crowdfund didn't reach the ${formatUsdc(CROWDFUND_CONSTANTS.MIN_SALE)} minimum raise. Once it's finalized, you'll be able to claim a refund of your committed ${formatUsdc(props.totalCommitted)} from here.`
              : `The crowdfund didn't reach the ${formatUsdc(CROWDFUND_CONSTANTS.MIN_SALE)} minimum raise. Once it's finalized, all committed USDC will be refundable to the addresses that participated.`}
          </p>
          <p className={styles.gateBodyFootnote}>
            Finalization is permissionless — anyone can trigger it. Refresh this page once it's done.
          </p>
          <div className={styles.gateActions}>
            <ArmadaButton
              variant="secondary"
              size="md"
              label="Back to crowdfund"
              showIcon={false}
              onClick={onGoToNetwork}
            />
          </div>
        </CardShell>
      )
    }
    return (
      <CardShell title="Awaiting finalization">
        <p className={styles.gateBody}>
          The commit window has closed. Once the sale is finalized you'll be able to claim your
          ARM allocation (and any USDC refund for over-cap commitments) from here.
        </p>
        <p className={styles.gateBodyFootnote}>
          Finalization is permissionless — anyone can trigger it. Refresh this page once it's done.
        </p>
        <div className={styles.gateActions}>
          <ArmadaButton
            variant="secondary"
            size="md"
            label="Back to crowdfund"
            showIcon={false}
            onClick={onGoToNetwork}
          />
        </div>
      </CardShell>
    )
  }

  // No allocation: don't show the submit path at all. Reaches here only after
  // the sale has been finalized successfully — i.e., the connected address
  // genuinely has nothing to claim (didn't commit, or committed under a
  // different wallet).
  if (mode === 'arm' && armAmount === 0n && refundAmount === 0n) {
    return (
      <CardShell title="Nothing to claim">
        <p className={styles.gateBody}>
          {walletAddress
            ? `${walletAddress.slice(0, 6)}…${walletAddress.slice(-4)} doesn't have a sale allocation. If you committed but the address doesn't match, switch wallets and try again.`
            : 'This address has no sale allocation.'}
        </p>
        <div className={styles.gateActions}>
          <ArmadaButton
            variant="secondary"
            size="md"
            label="Back to crowdfund"
            showIcon={false}
            onClick={onGoToNetwork}
          />
        </div>
      </CardShell>
    )
  }

  const stepsLabels = mode === 'arm' ? ARM_STEPS : REFUND_STEPS
  const currentStepIndex = step === 'review' ? 1 : step === 'submit' ? 2 : 3

  // ── Active flow ─────────────────────────────────────────────────

  if (step === 'review') {
    const delegateValid = /^0x[a-fA-F0-9]{40}$/.test(delegate)
    return (
      <FlowShell stepsLabels={stepsLabels} currentStep={currentStepIndex}>
        <h2 className={styles.flowHeading}>
          {mode === 'arm' ? 'Claim your ARM' : 'Claim your refund'}
        </h2>
        <p className={styles.flowSubheading}>
          {mode === 'arm'
            ? 'Review your allocation before submitting. Your delegate receives your governance voting power.'
            : 'The sale ended without meeting the minimum raise. You can claim your committed USDC back.'}
        </p>

        <div className={styles.summaryGrid}>
          {mode === 'arm' && (
            <SummaryRow label="ARM allocation" value={armDisplay} accent="lavender" />
          )}
          {mode === 'arm' && refundAmount > 0n && (
            <SummaryRow label="USDC refund" value={formatUsdc(refundAmount)} accent="warning" />
          )}
          {mode === 'refund' && (
            <SummaryRow label="USDC refund" value={refundDisplay} accent="warning" />
          )}
        </div>

        {mode === 'arm' && (
          <div className={styles.delegateBlock}>
            <label className={styles.delegateLabel}>Delegate address</label>
            <input
              type="text"
              value={delegate}
              onChange={(e) => setDelegate(e.target.value.trim())}
              placeholder="0x…"
              className={styles.delegateInput}
            />
            {!delegateValid && delegate.length > 0 && (
              <p className={styles.delegateError}>Not a valid 0x address.</p>
            )}
            <p className={styles.delegateHelp}>
              Your delegate votes on your behalf in governance. Use your own address to self-delegate.
            </p>
          </div>
        )}

        <div className={styles.flowActions}>
          <ArmadaButton
            variant="secondary"
            size="md"
            label="Cancel"
            showIcon={false}
            onClick={onGoToNetwork}
          />
          <ArmadaButton
            variant="primary"
            size="md"
            label={mode === 'arm' ? 'Claim ARM' : 'Claim refund'}
            showIcon={false}
            disabled={mode === 'arm' && !delegateValid}
            onClick={() => {
              setTxs(null)
              setStep('submit')
              void runClaim()
            }}
          />
        </div>
      </FlowShell>
    )
  }

  if (step === 'submit') {
    return (
      <div className={styles.submitShell}>
        {/* Reuse Step4Approve's controlled-tx surface. Single op; the second-row
            "Commit" slot collapses since we only pass one tx. */}
        <Step4Approve
          amount={mode === 'arm' ? Number(formatArm(armAmount).replace(/[, ARM]/g, '')) : 0}
          txs={txs ?? undefined}
          onDone={() => setStep('done')}
        />
      </div>
    )
  }

  // step === 'done'
  return (
    <DoneScreen
      mode={mode}
      armDisplay={armDisplay}
      refundDisplay={refundDisplay}
      onGoToMyPosition={onGoToMyPosition}
      onGoToNetwork={onGoToNetwork}
    />
  )
}

// ── Helpers ──────────────────────────────────────────────────────

function CardShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className={styles.gateShell}>
      <div className={styles.gateTitle}>{title}</div>
      <div>{children}</div>
    </div>
  )
}

function FlowShell({
  stepsLabels,
  currentStep,
  children,
}: {
  stepsLabels: string[]
  currentStep: number
  children: React.ReactNode
}) {
  return (
    <div className={styles.flowShell}>
      <div className={styles.flowInner}>
        <div className={styles.flowStepsWrap}>
          <Steps steps={stepsLabels} currentStep={currentStep} />
        </div>
        {children}
      </div>
    </div>
  )
}

function SummaryRow({
  label,
  value,
  accent,
}: {
  label: string
  value: string
  // 'lavender' = brand purple for ARM; 'warning' = amber-yellow for USDC refund.
  // Picked from Tag's token-driven dot palette — see --semantic-component-tag-dot-*.
  accent: 'lavender' | 'warning'
}) {
  return (
    <div className={styles.summaryRow}>
      <div className={styles.summaryLabel}>
        <Tag label={label} dot={accent} />
      </div>
      <div className={styles.summaryValue}>{value}</div>
    </div>
  )
}

function DoneScreen({
  mode,
  armDisplay,
  refundDisplay,
  onGoToMyPosition,
  onGoToNetwork,
  alreadyClaimed,
}: {
  mode: ClaimMode
  armDisplay: string
  refundDisplay: string
  onGoToMyPosition: () => void
  onGoToNetwork: () => void
  alreadyClaimed?: boolean
}) {
  return (
    <FlowShell stepsLabels={mode === 'arm' ? ARM_STEPS : REFUND_STEPS} currentStep={3}>
      <h2 className={styles.flowHeading}>
        {alreadyClaimed
          ? mode === 'arm'
            ? 'You already claimed your ARM'
            : 'You already claimed your refund'
          : mode === 'arm'
            ? 'ARM claimed'
            : 'Refund claimed'}
      </h2>
      <p className={styles.flowSubheading}>
        {mode === 'arm'
          ? `Your ${armDisplay} is in your wallet, and your delegate has voting power.`
          : `Your ${refundDisplay} has been returned to your wallet.`}
      </p>
      <div className={styles.flowActions}>
        <ArmadaButton
          variant="secondary"
          size="md"
          label="Back to crowdfund"
          showIcon={false}
          onClick={onGoToNetwork}
        />
        <ArmadaButton
          variant="primary"
          size="md"
          label="View my position"
          showIcon={false}
          onClick={onGoToMyPosition}
        />
      </div>
    </FlowShell>
  )
}
