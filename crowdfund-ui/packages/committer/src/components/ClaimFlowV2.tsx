// ABOUTME: v2 Claim flow page-level controller — ARM claim (with mandatory delegate) + USDC refund, dressed in @armada/ui primitives.
// ABOUTME: Provisional design: no designer mockup exists yet for Claim, so this composes Steps/Button/Tag with v1 ClaimTab behavior. Revisit when the designer ships claim screens.

import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Contract, ZeroAddress, type Signer, type JsonRpcProvider } from 'ethers'
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
  sanitizeAddressInput,
  isValidEnsName,
  truncateAddress,
  ADDRESS_INPUT_MAX_LENGTH,
} from '@armada/crowdfund-shared'
import { Steps, Button as ArmadaButton, Tooltip } from '@armada/ui'
import { InformationCircleIcon } from '@heroicons/react/24/solid'
import { sendAndWaitTx } from '@/lib/sendAndWaitTx'
import { savePendingTx, removePendingTx } from '@/lib/pendingTx'
import { resolveSigner, describeSignerError } from '@/lib/resolveSigner'
import { isMobileBrowser } from '@/lib/isMobileBrowser'
import { submitTxViaWagmi } from '@/lib/mobileTxSubmit'
import { getExplorerUrl, getHubChainId } from '@/config/network'
import { useBeforeUnloadGuard } from '@/hooks/useBeforeUnloadGuard'
import { getHubNetworkLabel } from '@/config/network'
import styles from './ClaimFlowV2.module.css'

type ClaimMode = 'arm' | 'refund'
type FlowStep = 'review' | 'submit' | 'done'
type DelegateEnsState = 'idle' | 'resolving' | 'resolved' | 'error'

/** Loose ENS prefilter — drives the "should we kick off resolution?" branch.
 *  Strict charset validation lives in `isValidEnsName`; this looser check still
 *  treats partial typing like "alice.et" as not-yet-ENS. Mirrors SlotCard. */
function isEnsCandidate(val: string): boolean {
  return val.endsWith('.eth') && val.length > 4
}

export interface ClaimFlowV2Props {
  walletConnected: boolean
  /** Connected but on a chain other than the hub — gates to a "switch network"
   *  prompt instead of the misleading "connect your wallet" copy. */
  isWrongNetwork?: boolean
  /** Trigger the hub-chain switch from the wrong-network gate. */
  switchNetwork?: () => void
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
    isWrongNetwork,
    switchNetwork,
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

  // Delegate input may be a raw 0x… address or an ENS name. `delegate` holds the
  // raw text; `resolvedDelegate` holds the checksummed address actually sent to
  // the contract (from ENS resolution or direct 0x); `delegateEns` tracks the
  // resolution state. Self-delegate is the default — prefill from the connected
  // (checksummed) wallet address.
  const [delegate, setDelegate] = useState<string>(walletAddress ?? '')
  const [resolvedDelegate, setResolvedDelegate] = useState<string>(() =>
    walletAddress ? (tryGetChecksumAddress(walletAddress) ?? '') : '',
  )
  const [delegateEns, setDelegateEns] = useState<DelegateEnsState>(() =>
    walletAddress && tryGetChecksumAddress(walletAddress) ? 'resolved' : 'idle',
  )
  // Mirror of `delegate` so an in-flight ENS lookup can drop a stale result if
  // the user kept typing while it was resolving.
  const delegateRef = useRef(delegate)
  delegateRef.current = delegate
  // Set locally the instant a claim confirms, so the done screen shows without
  // waiting for the `claimed` read to refetch.
  const [justClaimed, setJustClaimed] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const runningRef = useRef(false)
  // Once the user edits the delegate input, stop auto-filling it from the
  // wallet address — otherwise clearing the field instantly refills it.
  const hasUserEditedDelegate = useRef(false)
  // Cancellation for the in-flight claim tx — set on unmount (navigating away
  // from the claim page) so an orphaned run can't pop a wallet prompt. An
  // already-issued `tx.wait` is allowed to settle. The setup resets it to false
  // on (re)mount so StrictMode's dev mount→cleanup→mount cycle doesn't leave it
  // stuck `true` — which would silently short-circuit every `runClaim`.
  const cancelledRef = useRef(false)
  useEffect(() => {
    cancelledRef.current = false
    return () => {
      cancelledRef.current = true
    }
  }, [])
  const walletAddressRef = useRef(walletAddress)
  useEffect(() => { walletAddressRef.current = walletAddress }, [walletAddress])
  // Warn before a refresh/tab-close drops the user while a claim is broadcasting.
  useBeforeUnloadGuard(submitting)

  const [step, setStep] = useState<FlowStep>('review')
  const [txs, setTxs] = useState<Step4Transaction[] | null>(null)

  // Decide claim mode based on contract state. Phase 2 (cancelled) → refund.
  // Phase 0 with refundMode (cappedDemand < min) → refund. Otherwise → ARM.
  // This mirrors v1 ClaimTab's mode derivation.
  const mode: ClaimMode = phase === 2 || refundMode ? 'refund' : 'arm'

  // Default delegate to the connected wallet address when it becomes available
  // (self-delegate), unless the user has already edited the field.
  useEffect(() => {
    if (hasUserEditedDelegate.current) return
    if (walletAddress && delegate === '') {
      // Display the raw address; resolve to the checksummed form internally.
      const checksummed = tryGetChecksumAddress(walletAddress)
      setDelegate(walletAddress)
      setResolvedDelegate(checksummed ?? '')
      setDelegateEns(checksummed ? 'resolved' : 'idle')
    }
  }, [walletAddress, delegate])

  // Delegate input handler — mirrors SlotCard's onchain-invite address field:
  // an ENS-looking value is resolved via the hub provider; a raw 0x… value is
  // checksum-validated. Either way `resolvedDelegate` ends up holding the
  // canonical checksummed address (or '' when unresolved).
  const handleDelegateChange = async (raw: string) => {
    hasUserEditedDelegate.current = true
    const val = sanitizeAddressInput(raw)
    setDelegate(val)
    setResolvedDelegate('')

    if (val.length === 0) {
      setDelegateEns('idle')
      return
    }

    if (isEnsCandidate(val)) {
      // Strict charset gate before burning an RPC round-trip.
      if (!isValidEnsName(val) || !provider) {
        setDelegateEns('error')
        return
      }
      setDelegateEns('resolving')
      try {
        const resolved = await provider.resolveName(val)
        if (val !== delegateRef.current) return // user kept typing — drop stale
        const checksummed = resolved ? tryGetChecksumAddress(resolved) : null
        // Reject the zero address — the contract requires a non-zero delegate.
        if (!checksummed || checksummed === ZeroAddress) {
          setDelegateEns('error')
          return
        }
        setResolvedDelegate(checksummed)
        setDelegateEns('resolved')
      } catch {
        if (val !== delegateRef.current) return
        setDelegateEns('error')
      }
      return
    }

    // Direct 0x… entry — validate the EIP-55 checksum, keep canonical casing.
    const checksummed = tryGetChecksumAddress(val)
    if (checksummed && checksummed !== ZeroAddress) {
      setResolvedDelegate(checksummed)
      setDelegateEns('resolved')
    } else if (checksummed === ZeroAddress) {
      // Valid format but the zero address — rejected with a specific message.
      setDelegateEns('error')
    } else {
      setDelegateEns('idle')
    }
  }

  // Load allocation + claimed state via react-query, keyed by account/contract/
  // phase. The two reads run in parallel via `allSettled` so a revert on one
  // doesn't sink the other: `claimed` failure is non-fatal (stays false) so the
  // post-claim short-circuit still works, while a `computeAllocation()` RPC
  // failure flags `readError` to show a retry instead of a misleading "0 ARM".
  // `computeAllocation()` is only callable in `Phase.Finalized` (phase === 1);
  // for cancelled (phase === 2) it's skipped (would revert), the refund path
  // using `totalCommitted` from props. Keying by walletAddress means an account
  // switch starts a fresh (loading) query — no prior account's state leaks.
  const claimReadsEnabled = !!provider && !!crowdfundAddress && !!walletAddress && phase >= 1
  const claimQuery = useQuery({
    queryKey: ['claimReads', walletAddress, crowdfundAddress, phase],
    enabled: claimReadsEnabled,
    staleTime: 0,
    retry: false,
    queryFn: async () => {
      const contract = new Contract(crowdfundAddress!, CROWDFUND_ABI_FRAGMENTS, provider!)
      const [claimedRes, allocRes] = await Promise.allSettled([
        contract.claimed(walletAddress) as Promise<boolean>,
        phase === 1
          ? (contract.computeAllocation(walletAddress) as Promise<[bigint, bigint]>)
          : Promise.resolve(null),
      ])
      const hasClaimed = claimedRes.status === 'fulfilled' ? claimedRes.value : false
      let armAmount = 0n
      let refundAmount = 0n
      let readError = false
      if (phase === 1) {
        if (allocRes.status === 'fulfilled' && allocRes.value) {
          armAmount = allocRes.value[0]
          refundAmount = allocRes.value[1]
        } else if (allocRes.status === 'rejected') {
          readError = true
        }
      }
      return { hasClaimed, armAmount, refundAmount, readError }
    },
  })

  const reads = claimQuery.data ?? { hasClaimed: false, armAmount: 0n, refundAmount: 0n, readError: false }
  const hasClaimed = reads.hasClaimed || justClaimed
  const armAmount = reads.armAmount
  const refundAmount = reads.refundAmount
  const readError = reads.readError
  // `loading` only while an enabled query has no data yet (false when disabled,
  // so the gate states render). An account switch re-keys the query → loading.
  const loading = claimReadsEnabled && claimQuery.isPending

  // What the user actually gets back.
  const armDisplay = useMemo(() => formatArm(armAmount), [armAmount])
  const refundDisplay = useMemo(
    () => formatUsdc(mode === 'refund' ? totalCommitted : refundAmount),
    [mode, totalCommitted, refundAmount],
  )

  // Submit the claim/refund transaction through the shared single-step engine,
  // so it inherits the two-phase labels, explorer link, and quiet-rejection
  // handling. Updates `txs` so Step4Approve renders controlled status.
  const runClaim = async () => {
    if (runningRef.current) return
    const opLabel = mode === 'arm' ? 'Claim ARM' : 'Claim USDC refund'
    if (!crowdfundAddress) {
      // Surface an error row instead of bailing into Step4's neutral state.
      setTxs([
        { label: opLabel, status: 'error', errorMessage: 'Still loading the crowdfund — try again in a moment.' },
      ])
      return
    }
    // Submit the canonical checksummed delegate — `resolvedDelegate` is set by
    // handleDelegateChange (from ENS resolution or a direct 0x… entry). Fall
    // back to checksumming the raw input as a defense-in-depth backstop.
    const delegateAddress = resolvedDelegate || tryGetChecksumAddress(delegate)
    if (mode === 'arm' && (!delegateAddress || delegateAddress === ZeroAddress)) {
      setTxs([
        { label: opLabel, status: 'error', errorMessage: 'Enter a valid delegate address.' },
      ])
      return
    }
    // Bail before prompting if the run was cancelled (unmount) or the connected
    // account changed.
    const startAddress = walletAddress
    if (cancelledRef.current || walletAddressRef.current !== startAddress) return

    runningRef.current = true
    setSubmitting(true)
    setTxs([{ label: opLabel, status: 'loading', phaseLabel: 'Confirm in your wallet…' }])

    // Prefer the hook-derived signer; when it's missing, resolve one
    // imperatively from the connector. useWalletClient's cached query can stay
    // undefined for an entire session after a fresh connect (wagmi #2784 /
    // #3825) even though the connector is fine — ask it directly at click time.
    let activeSigner: Signer | null = signer
    if (!activeSigner) {
      try {
        activeSigner = await resolveSigner()
      } catch (err) {
        setTxs([{ label: opLabel, status: 'error', errorMessage: describeSignerError(err) }])
        runningRef.current = false
        setSubmitting(false)
        return
      }
    }

    const explorerUrl = getExplorerUrl()
    const result = await sendAndWaitTx(
      () => {
        const crowdfund = new Contract(crowdfundAddress, CROWDFUND_ABI_FRAGMENTS, activeSigner)
        // Mobile: submit via wagmi so MetaMask Mobile surfaces the request (the
        // ethers signer transport doesn't trigger the WC redirect). Desktop keeps
        // the ethers path unchanged.
        if (isMobileBrowser()) {
          return mode === 'arm'
            ? submitTxViaWagmi(crowdfund, 'claim', [delegateAddress!])
            : submitTxViaWagmi(crowdfund, 'claimRefund', [])
        }
        return mode === 'arm' ? crowdfund.claim(delegateAddress!) : crowdfund.claimRefund()
      },
      (hash) => {
        // Persist the broadcast so the header tx chip (via usePendingTxWatcher)
        // surfaces it across pages, and the watcher refreshes balances + resolves
        // it even if the user navigates away or reloads before it confirms.
        savePendingTx({
          chainId: getHubChainId(),
          address: startAddress ?? '',
          txHash: hash,
          label: opLabel,
          sentAt: Date.now(),
        })
        setTxs([{ label: opLabel, status: 'loading', phaseLabel: 'Submitting…', hash, explorerUrl }])
      },
    )
    runningRef.current = false
    setSubmitting(false)

    // A resolved tx no longer needs watching; a timed-out one may still confirm,
    // so it stays persisted for the post-timeout watcher. Mirrors the commit pipeline.
    if (result.hash && result.outcome !== 'timeout') removePendingTx(result.hash)

    if (result.outcome === 'success') {
      setTxs([{ label: opLabel, status: 'done', hash: result.hash, explorerUrl }])
      setJustClaimed(true)
      // Fast-path the Allocated / RefundClaimed receipt log into the event store
      // and refresh balances.
      onReceiptLogs?.(result.logs ?? [])
      void refreshAllowance?.()
      setTimeout(() => setStep('done'), 600)
      return
    }
    if (result.outcome === 'rejected') {
      // Quiet — the user declined; return to review without a red error row.
      setTxs(null)
      setStep('review')
      return
    }
    // reverted / timeout / error
    setTxs([
      {
        label: opLabel,
        status: 'error',
        errorMessage: result.errorMessage,
        errorDetails: result.errorDetails,
        hash: result.hash,
        explorerUrl,
      },
    ])
  }

  // ── Gate states ─────────────────────────────────────────────────

  if (!walletConnected) {
    // `walletConnected` is false both when disconnected and when on the wrong
    // chain. Distinguish them so a connected-but-wrong-chain user gets a switch
    // prompt rather than the misleading "connect your wallet" copy.
    if (isWrongNetwork) {
      return (
        <CardShell title="Wrong network">
          <p className={styles.gateBody}>
            Switch to {getHubNetworkLabel()} to claim your ARM tokens or USDC refund.
          </p>
          <div className={styles.gateActions}>
            <ArmadaButton
              variant="secondary"
              size="md"
              label={`Switch to ${getHubNetworkLabel()}`}
              showIcon={false}
              onClick={() => switchNetwork?.()}
            />
          </div>
        </CardShell>
      )
    }
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

  // Allocation read failed (RPC error, not a contract "no allocation"). Don't
  // render a misleading "0 ARM" — offer a retry.
  if (readError) {
    return (
      <CardShell title="Couldn't load your allocation">
        <p className={styles.gateBody}>Something went wrong fetching your share. Try again.</p>
        <ArmadaButton
          variant="secondary"
          size="md"
          label="Retry"
          showIcon={false}
          onClick={() => void claimQuery.refetch()}
        />
      </CardShell>
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
    const delegateValid = delegateEns === 'resolved' && resolvedDelegate !== ''
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
                autoComplete="off"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                maxLength={ADDRESS_INPUT_MAX_LENGTH}
                value={delegate}
                onChange={(e) => void handleDelegateChange(e.target.value)}
                placeholder="0x… or name.eth"
                className={[
                  styles.delegateInput,
                  delegateEns === 'error' ? styles.delegateInputError : '',
                  delegateEns === 'resolved' ? styles.delegateInputResolved : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
              />
              {delegateEns === 'resolving' && (
                <p className={styles.delegateHelp}>Resolving ENS…</p>
              )}
              {delegateEns === 'resolved' && resolvedDelegate && isValidEnsName(delegate) && (
                <p className={styles.delegateResolved}>
                  Resolves to <code>{truncateAddress(resolvedDelegate)}</code>
                </p>
              )}
              {delegateEns === 'error' && (
                <p className={styles.delegateError}>
                  {tryGetChecksumAddress(delegate) === ZeroAddress
                    ? 'The delegate can’t be the zero address.'
                    : 'Couldn’t resolve that ENS name.'}
                </p>
              )}
              {delegateEns === 'idle' && delegate.startsWith('0x') && (
                <p className={styles.delegateError}>Not a valid 0x address.</p>
              )}
              <p className={styles.delegateHelp}>
                Your delegate votes on your behalf in governance. Use your own address to
                self-delegate. ENS names (name.eth) are supported.
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
