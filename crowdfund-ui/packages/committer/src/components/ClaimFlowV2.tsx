// ABOUTME: v2 Claim flow page-level controller — ARM claim (with mandatory delegate) + USDC refund, dressed in @armada/ui primitives.
// ABOUTME: Provisional design: no designer mockup exists yet for Claim, so this composes Steps/Button/Tag with v1 ClaimTab behavior. Revisit when the designer ships claim screens.

import { useEffect, useMemo, useState } from 'react'
import { Contract, type Signer, type TransactionResponse, type JsonRpcProvider } from 'ethers'
import {
  Step4Approve,
  type Step4Transaction,
  CROWDFUND_ABI_FRAGMENTS,
  CROWDFUND_CONSTANTS,
  formatArm,
  formatUsdc,
  formatCountdown,
} from '@armada/crowdfund-shared'
import { Steps, Button as ArmadaButton, Tag } from '@armada/ui'
import { mapRevertToMessage } from '@/lib/revertMessages'

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
      setTimeout(() => setStep('done'), 600)
    } catch (err) {
      setRowStatus({ status: 'error', errorMessage: mapRevertToMessage(err) })
    }
  }

  // ── Gate states ─────────────────────────────────────────────────

  if (!walletConnected) {
    return (
      <CardShell title="Connect your wallet to claim">
        <p className="text-muted-foreground">
          Once the campaign finalizes you'll be able to claim ARM tokens (or a USDC refund) from
          here.
        </p>
      </CardShell>
    )
  }

  if (!claimAvailable) {
    return (
      <CardShell title="Claiming isn't open yet">
        <p className="text-muted-foreground">
          You'll be able to claim ARM tokens (or a USDC refund if the sale ends below the minimum
          raise) from here.
        </p>
        {claimCountdownSeconds !== undefined && claimCountdownSeconds > 0 && (
          <p className="mt-3 text-muted-foreground">
            Estimated:{' '}
            <span className="text-foreground">{formatCountdown(claimCountdownSeconds)}</span>
          </p>
        )}
        <div className="mt-6">
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
        <p className="text-muted-foreground">Fetching your share of the sale.</p>
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
          <p className="text-muted-foreground">
            {props.totalCommitted > 0n
              ? `The crowdfund didn't reach the ${formatUsdc(CROWDFUND_CONSTANTS.MIN_SALE)} minimum raise. Once it's finalized, you'll be able to claim a refund of your committed ${formatUsdc(props.totalCommitted)} from here.`
              : `The crowdfund didn't reach the ${formatUsdc(CROWDFUND_CONSTANTS.MIN_SALE)} minimum raise. Once it's finalized, all committed USDC will be refundable to the addresses that participated.`}
          </p>
          <p className="mt-3 text-xs text-muted-foreground">
            Finalization is permissionless — anyone can trigger it. Refresh this page once it's done.
          </p>
          <div className="mt-6">
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
        <p className="text-muted-foreground">
          The commit window has closed. Once the sale is finalized you'll be able to claim your
          ARM allocation (and any USDC refund for over-cap commitments) from here.
        </p>
        <p className="mt-3 text-xs text-muted-foreground">
          Finalization is permissionless — anyone can trigger it. Refresh this page once it's done.
        </p>
        <div className="mt-6">
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
        <p className="text-muted-foreground">
          {walletAddress
            ? `${walletAddress.slice(0, 6)}…${walletAddress.slice(-4)} doesn't have a sale allocation. If you committed but the address doesn't match, switch wallets and try again.`
            : 'This address has no sale allocation.'}
        </p>
        <div className="mt-6">
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
        <h2 className="mb-2 text-2xl">
          {mode === 'arm' ? 'Claim your ARM' : 'Claim your refund'}
        </h2>
        <p className="mb-8 text-muted-foreground">
          {mode === 'arm'
            ? 'Review your allocation before submitting. Your delegate receives your governance voting power.'
            : 'The sale ended without meeting the minimum raise. You can claim your committed USDC back.'}
        </p>

        <div className="mb-6 grid grid-cols-2 gap-3">
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
          <div className="mb-6">
            <label className="mb-2 block text-sm uppercase tracking-widest text-muted-foreground">
              Delegate address
            </label>
            <input
              type="text"
              value={delegate}
              onChange={(e) => setDelegate(e.target.value.trim())}
              placeholder="0x…"
              className="w-full rounded-md border border-border/60 bg-background/40 px-3 py-2 font-mono text-sm text-foreground focus:border-primary focus:outline-none"
            />
            {!delegateValid && delegate.length > 0 && (
              <p className="mt-1 text-xs text-destructive">Not a valid 0x address.</p>
            )}
            <p className="mt-2 text-xs text-muted-foreground">
              Your delegate votes on your behalf in governance. Use your own address to self-delegate.
            </p>
          </div>
        )}

        <div className="flex gap-3">
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
      // 12rem = 2 × (AppShell main `pt-20` + container `p-4-top`) — needed so
      // the centered content lands at the viewport's visual midline. A plain
      // `min-h-screen` overflows and pushes the center down by the full chrome
      // offset; subtracting only the header (5rem) still leaves it half-low.
      <div className="flex min-h-[calc(100vh-12rem)] items-center justify-center">
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
    <div className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center gap-3 text-center">
      <div className="text-2xl">{title}</div>
      <div className="text-sm">{children}</div>
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
    // `100vh - 5rem` matches AppShell's `pt-20` header clearance — a bare
    // `min-h-screen` overflows the viewport, dropping the centered content
    // below the visual midline by the header's height.
    <div className="flex min-h-[calc(100vh-12rem)] items-center justify-center px-6">
      <div className="w-full max-w-xl">
        <div className="mb-8">
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
    <div className="rounded-md border border-border/60 bg-background/40 p-4">
      <div className="mb-2">
        <Tag label={label} dot={accent} />
      </div>
      <div className="text-xl text-foreground">{value}</div>
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
      <h2 className="mb-2 text-2xl">
        {alreadyClaimed
          ? mode === 'arm'
            ? 'You already claimed your ARM'
            : 'You already claimed your refund'
          : mode === 'arm'
            ? 'ARM claimed'
            : 'Refund claimed'}
      </h2>
      <p className="mb-8 text-muted-foreground">
        {mode === 'arm'
          ? `Your ${armDisplay} is in your wallet, and your delegate has voting power.`
          : `Your ${refundDisplay} has been returned to your wallet.`}
      </p>
      <div className="flex gap-3">
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
