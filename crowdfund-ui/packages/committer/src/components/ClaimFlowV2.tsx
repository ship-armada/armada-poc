// ABOUTME: v2 Claim flow page-level controller — ARM claim (with mandatory delegate) + USDC refund, dressed in @armada/ui primitives.
// ABOUTME: Provisional design: no designer mockup exists yet for Claim, so this composes Steps/Button/Tag with v1 ClaimTab behavior. Revisit when the designer ships claim screens.

import { useEffect, useMemo, useRef, useState } from 'react'
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
  tryGetChecksumAddress,
} from '@armada/crowdfund-shared'
import { Steps, Button as ArmadaButton, Tooltip } from '@armada/ui'
import { InformationCircleIcon } from '@heroicons/react/24/solid'
import { mapRevertToMessage } from '@/lib/revertMessages'
import { TX_WAIT_TIMEOUT_MS, TX_PENDING_MESSAGE, isTxTimeoutError } from '@/lib/txWait'
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
  const [submitting, setSubmitting] = useState(false)
  const runningRef = useRef(false)

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
  //
  // The two reads are issued independently rather than via `Promise.all` so a
  // revert on one doesn't sink the other. `computeAllocation()` reverts when
  // the sale is cancelled (phase === 2) — without this split, a successful
  // `claimRefund()` would never flip `hasClaimed` to true on revisit, leaving
  // the user staring at the review screen and able to re-submit a tx the
  // contract will reject.
  useEffect(() => {
    if (!provider || !crowdfundAddress || !walletAddress || phase < 1) {
      setLoading(false)
      return
    }
    let cancelled = false
    const fetchAllocation = async () => {
      const contract = new Contract(crowdfundAddress, CROWDFUND_ABI_FRAGMENTS, provider)

      // `claimed[user]` is set by both `claim()` and `claimRefund()` — same
      // gate for both success-path and refund-mode flows. Read it first so
      // the post-claim short-circuit still fires when the allocation read
      // can't run.
      try {
        const claimed = (await contract.claimed(walletAddress)) as boolean
        if (!cancelled) setHasClaimed(claimed)
      } catch {
        // Non-fatal — leave `hasClaimed` at its initial value.
      }

      // `computeAllocation()` is only callable in `Phase.Finalized`. Skip the
      // call entirely for cancelled (phase === 2) since it would revert; the
      // refund-mode codepath only needs `totalCommitted` from props, not the
      // allocation tuple.
      if (phase === 1) {
        try {
          const allocation = (await contract.computeAllocation(walletAddress)) as [
            bigint,
            bigint,
          ]
          if (!cancelled) {
            setArmAmount(allocation[0])
            setRefundAmount(allocation[1])
          }
        } catch {
          // Non-fatal — keep zero values; UI shows "no allocation" state.
        }
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
    if (runningRef.current) return
    const opLabel = mode === 'arm' ? 'Claim ARM' : 'Claim USDC refund'
    if (!signer || !crowdfundAddress) {
      // Surface an error row instead of bailing into Step4's neutral state.
      setTxs([
        { label: opLabel, status: 'error', errorMessage: 'Wallet not ready — reconnect and retry.' },
      ])
      return
    }
    // Checksum the delegate (ethers EIP-55) and submit the canonical form. A
    // mixed-case address with a bad checksum is rejected rather than delegated wrong.
    const delegateChecksum = tryGetChecksumAddress(delegate)
    if (mode === 'arm' && !delegateChecksum) {
      setTxs([
        { label: opLabel, status: 'error', errorMessage: 'Enter a valid delegate address.' },
      ])
      return
    }
    runningRef.current = true
    setSubmitting(true)
    setTxs([{ label: opLabel, status: 'loading' }])

    const setRowStatus = (patch: Partial<Step4Transaction>) =>
      setTxs((prev) => (prev ? [{ ...prev[0], ...patch }] : prev))

    let txHash: string | undefined
    try {
      const crowdfund = new Contract(crowdfundAddress, CROWDFUND_ABI_FRAGMENTS, signer)
      const tx: TransactionResponse =
        mode === 'arm' ? await crowdfund.claim(delegateChecksum) : await crowdfund.claimRefund()
      txHash = tx.hash
      const receipt = await tx.wait(1, TX_WAIT_TIMEOUT_MS)
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
      if (isTxTimeoutError(err)) {
        setRowStatus({
          status: 'error',
          errorMessage: TX_PENDING_MESSAGE,
          errorDetails: txHash ? `Transaction hash: ${txHash}` : undefined,
        })
        return
      }
      setRowStatus({
        status: 'error',
        errorMessage: mapRevertToMessage(err),
        errorDetails: err instanceof Error ? err.message : String(err),
      })
    } finally {
      runningRef.current = false
      setSubmitting(false)
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
        refundAmount={refundAmount}
        onGoToMyPosition={onGoToMyPosition}
        onGoToNetwork={onGoToNetwork}
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

  const stepsLabels = mode === 'arm' ? ARM_STEPS : REFUND_STEPS
  const currentStepIndex = step === 'review' ? 1 : step === 'submit' ? 2 : 3

  // No allocation: don't show the submit path at all. Reaches here only after
  // the sale has been finalized successfully — the connected address
  // genuinely has nothing to claim (didn't commit, or committed under a
  // different wallet). Renders in the same shell as the DoneScreen so the
  // terminal state is visually consistent with a successful claim.
  const armNothing = mode === 'arm' && armAmount === 0n && refundAmount === 0n
  const refundNothing = mode === 'refund' && totalCommitted === 0n
  if (armNothing || refundNothing) {
    return (
      <NothingToClaimScreen
        mode={mode}
        walletAddress={walletAddress}
        stepsLabels={stepsLabels}
        onGoToMyPosition={onGoToMyPosition}
        onGoToNetwork={onGoToNetwork}
      />
    )
  }

  // ── Active flow ─────────────────────────────────────────────────

  if (step === 'review') {
    const delegateValid = tryGetChecksumAddress(delegate) !== null
    const armHasRefund = mode === 'arm' && refundAmount > 0n
    return (
      <FlowShell stepsLabels={stepsLabels} currentStep={currentStepIndex}>
        <div className={styles.cardContent}>
          <h2 className={styles.cardTitle}>
            {mode === 'arm' ? 'Claim your ARM' : 'Claim your refund'}
          </h2>

          {/* Single summary card with row dividers — matches Step3Review. */}
          <div className={styles.summaryCard}>
            {mode === 'arm' && (
              <>
                <div className={styles.summaryRow}>
                  <div className={styles.summaryLabelGroup}>
                    <span className={styles.summaryLabel}>ARM allocation</span>
                    <Tooltip
                      variant="rich"
                      title="ARM allocation"
                      description="The ARM tokens delivered to your wallet by this transaction."
                      bullets={[
                        'Pro-rata share of the sale, capped at your hop allocation',
                        'Delegate set below receives your governance voting power',
                        'Any committed USDC not used to buy ARM is refunded in the same tx',
                      ]}
                    >
                      <button
                        type="button"
                        className={styles.infoTrigger}
                        aria-label="ARM allocation details"
                      >
                        <InformationCircleIcon className={styles.infoIcon} aria-hidden />
                      </button>
                    </Tooltip>
                  </div>
                  <span className={styles.summaryValueAccent}>{armDisplay}</span>
                </div>
                {armHasRefund && (
                  <>
                    <div className={styles.divider} />
                    <div className={styles.summaryRow}>
                      <span className={styles.summaryLabel}>USDC refund</span>
                      <span className={styles.summaryValue}>{formatUsdc(refundAmount)}</span>
                    </div>
                  </>
                )}
              </>
            )}
            {mode === 'refund' && (
              <div className={styles.summaryRow}>
                <span className={styles.summaryLabel}>USDC refund</span>
                <span className={styles.summaryValue}>{refundDisplay}</span>
              </div>
            )}
          </div>

          {/* Lavender-tinted note pinned under the allocation so the user reads
              "this is what hits your wallet" before any input. Same surface as
              Step3Review's warning block. */}
          <div className={styles.warningBlock}>
            <p className={styles.warningText}>
              {mode === 'arm'
                ? armHasRefund
                  ? 'A single transaction delivers your ARM and your USDC refund.'
                  : 'A single transaction delivers your ARM and any over-cap USDC refund.'
                : phase === 2
                  ? 'The sale was cancelled by the security council. Your full committed USDC is available to claim back.'
                  : 'The sale ended below the minimum raise, so no ARM was sold. Your full committed USDC is available to claim back.'}
            </p>
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
                Your delegate votes on your behalf in governance. Use your own address to
                self-delegate.
              </p>
            </div>
          )}
        </div>

        <div className={styles.buttonRow}>
          <ArmadaButton
            variant="secondary"
            size="lg"
            label="Cancel"
            showIcon={false}
            onClick={onGoToNetwork}
          />
          <ArmadaButton
            variant="gradient"
            size="lg"
            label={mode === 'arm' ? 'Claim ARM' : 'Claim refund'}
            showIcon={false}
            disabled={(mode === 'arm' && !delegateValid) || submitting}
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
            "Commit" slot collapses since we only pass one tx. `steps` /
            `stepIndex` are forwarded so the inner Steps bar shows the claim's
            3-step set ('Review / Submit / Done') at index 2, not Step4's
            commit-flow default ('…/ Confirmation' at index 4). */}
        <Step4Approve
          steps={stepsLabels}
          stepIndex={currentStepIndex}
          // Singular variant — claim submits a single tx, unlike commit's
          // Approve + Commit pair. Same two-line shape as the default so the
          // card height doesn't shift.
          title={<>Confirm transaction<br />on your wallet</>}
          amount={mode === 'arm' ? Number(formatArm(armAmount).replace(/[, ARM]/g, '')) : 0}
          txs={txs ?? undefined}
          onDone={() => setStep('done')}
          onBack={() => {
            setTxs(null)
            setStep('review')
          }}
          onRetry={() => {
            setTxs(null)
            void runClaim()
          }}
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
      refundAmount={refundAmount}
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
      <div className={styles.cardShell}>
        <Steps steps={stepsLabels} currentStep={currentStep} />
        {children}
      </div>
    </div>
  )
}

function NothingToClaimScreen({
  mode,
  walletAddress,
  stepsLabels,
  onGoToMyPosition,
  onGoToNetwork,
}: {
  mode: ClaimMode
  walletAddress: string | null
  stepsLabels: string[]
  onGoToMyPosition: () => void
  onGoToNetwork: () => void
}) {
  // Mirror DoneScreen's terminal-state composition (heroBlock + nextCard +
  // button row) so the "nothing to claim" outcome reads as a deliberate end
  // of the flow rather than an error. Stepper sits at step 3 to underline
  // "you've reached the end" — same as the success path.
  const headline = mode === 'arm' ? 'Nothing to claim.' : 'No refund to claim.'
  const shortAddress = walletAddress
    ? `${walletAddress.slice(0, 6)}…${walletAddress.slice(-4)}`
    : null
  const subline =
    mode === 'arm' ? (
      shortAddress ? (
        <>
          {shortAddress} has no sale allocation.
          <br />
          You may have committed with a different wallet.
        </>
      ) : (
        <>This address has no sale allocation.</>
      )
    ) : shortAddress ? (
      <>
        {shortAddress} didn't commit any USDC to the sale.
        <br />
        You may have committed with a different wallet.
      </>
    ) : (
      <>This address didn't commit any USDC to the sale.</>
    )
  const nextText =
    mode === 'arm'
      ? 'If you committed but expected an allocation here, switch to the wallet you used to commit and reload the claim page.'
      : 'If you expected a refund here, switch to the wallet you used to commit and reload the claim page.'

  return (
    <FlowShell stepsLabels={stepsLabels} currentStep={3}>
      <div className={styles.cardContent}>
        <div className={styles.heroBlock}>
          <h1 className={styles.headline}>{headline}</h1>
          <p className={styles.subline}>{subline}</p>
        </div>

        <div className={styles.nextCard}>
          <span className={styles.nextEyebrow}>WHAT'S NEXT</span>
          <p className={styles.nextText}>{nextText}</p>
        </div>
      </div>

      <div className={styles.buttonRow}>
        <ArmadaButton
          variant="secondary"
          size="lg"
          label="Back to crowdfund"
          showIcon={false}
          onClick={onGoToNetwork}
        />
        <ArmadaButton
          variant="gradient"
          size="lg"
          label="View my position"
          showIcon={false}
          onClick={onGoToMyPosition}
        />
      </div>
    </FlowShell>
  )
}

function DoneScreen({
  mode,
  armDisplay,
  refundDisplay,
  refundAmount,
  onGoToMyPosition,
  onGoToNetwork,
}: {
  mode: ClaimMode
  armDisplay: string
  refundDisplay: string
  /** Over-cap USDC refund delivered by the ARM `claim()` call. Used to swap in
   *  the "ARM + USDC refund" copy when applicable; ignored for `mode='refund'`
   *  (the refund there is the whole `refundDisplay`). */
  refundAmount: bigint
  onGoToMyPosition: () => void
  onGoToNetwork: () => void
}) {
  // Same headline on first-success and on revisit — the action is idempotent
  // from the user's perspective, and "You already claimed" reads like an
  // error. Past-tense success copy works for both cases.
  const armHasRefund = mode === 'arm' && refundAmount > 0n
  const headline = mode === 'arm' ? 'ARM claimed.' : 'Refund claimed.'
  const subline =
    mode === 'arm' ? (
      armHasRefund ? (
        <>
          {armDisplay} is in your wallet.
          <br />
          {refundDisplay} USDC refund returned too.
        </>
      ) : (
        <>
          {armDisplay} is in your wallet.
          <br />
          Your delegate now holds your governance voting power.
        </>
      )
    ) : (
      <>{refundDisplay} returned to your wallet.</>
    )
  const nextText =
    mode === 'arm'
      ? armHasRefund
        ? 'Both transfers are already settled on-chain. View your position to confirm balances, or head back to the crowdfund to see how the rest of the fleet finalized.'
        : 'Your ARM is settled on-chain and your delegate is active. View your position to confirm the balance, or head back to the crowdfund.'
      : 'Your USDC refund is settled on-chain. View your position to confirm the balance, or head back to the crowdfund.'

  return (
    <FlowShell stepsLabels={mode === 'arm' ? ARM_STEPS : REFUND_STEPS} currentStep={3}>
      <div className={styles.cardContent}>
        <div className={styles.heroBlock}>
          <h1 className={styles.headline}>{headline}</h1>
          <p className={styles.subline}>{subline}</p>
        </div>

        <div className={styles.nextCard}>
          <span className={styles.nextEyebrow}>WHAT'S NEXT</span>
          <p className={styles.nextText}>{nextText}</p>
        </div>
      </div>

      <div className={styles.buttonRow}>
        <ArmadaButton
          variant="secondary"
          size="lg"
          label="Back to crowdfund"
          showIcon={false}
          onClick={onGoToNetwork}
        />
        <ArmadaButton
          variant="gradient"
          size="lg"
          label="View my position"
          showIcon={false}
          onClick={onGoToMyPosition}
        />
      </div>
    </FlowShell>
  )
}
