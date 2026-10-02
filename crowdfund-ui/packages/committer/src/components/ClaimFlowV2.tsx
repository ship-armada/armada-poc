// ABOUTME: Claim flow — Intro → Delegate → Review → Submit → Done (ARM), or Intro → Submit → Done (refund).
// ABOUTME: Crowdfund ClaimFlow UX (FlowChrome) wired to live on-chain claim/refund, ENS resolve, pending-tx, and in-flight reconstruct.

import { Fragment, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Contract, ZeroAddress, type Signer, type JsonRpcProvider } from 'ethers'
import {
  InformationCircleIcon,
  MagnifyingGlassIcon,
} from '@heroicons/react/24/outline'
import { CheckCircleIcon } from '@heroicons/react/24/solid'
import {
  FlowChrome,
  StaleDataBanner,
  UsefulLinks,
  WalletConfirmStep,
  type Step4Transaction,
  type ReceiptLogLike,
  CROWDFUND_ABI_FRAGMENTS,
  CROWDFUND_CONSTANTS,
  HOP_CONFIGS,
  formatArm,
  formatUsdc,
  formatCountdown,
  tryGetChecksumAddress,
  sanitizeAddressInput,
  isValidEnsName,
  truncateAddress,
  ADDRESS_INPUT_MAX_LENGTH,
} from '@armada/crowdfund-shared'
import { Button as ArmadaButton, Tooltip } from '@armada/ui'
import { sendAndWaitTx } from '@/lib/sendAndWaitTx'
import { savePendingTx, removePendingTx } from '@/lib/pendingTx'
import { setClaimInFlight, getClaimInFlight, clearClaimInFlight } from '@/lib/claimInFlight'
import { TX_WAIT_TIMEOUT_MS, isTxTimeoutError } from '@/lib/txWait'
import { resolveSigner, describeSignerError } from '@/lib/resolveSigner'
import { submitWrite } from '@/lib/submitWrite'
import { confirmClaimClose } from '@/lib/claimModal'
import { getExplorerUrl, getHubChainId, getTxConfirmations } from '@/config/network'
import { useBeforeUnloadGuard } from '@/hooks/useBeforeUnloadGuard'
import { getHubNetworkLabel } from '@/config/network'
import styles from './ClaimFlowV2.module.css'

type ClaimMode = 'arm' | 'refund'
type FlowStep = 'intro' | 'delegate' | 'review' | 'submit' | 'done'
type DelegateChoice = 'self' | 'other'
type DelegateScreen = 'choice' | 'picker'
type DelegateEnsState = 'idle' | 'resolving' | 'resolved' | 'error'

const ARM_CLAIM_STEPS = [
  { label: 'Delegate', hint: 'Select how to delegate your vote' },
  { label: 'Review', hint: 'Confirm allocation and delegate' },
  { label: 'Confirm', hint: 'Approve claim in your wallet' },
] as const

const ARM_KNOW_ITEMS = [
  'You’ll need a little ETH in this wallet for gas.',
  'A single transaction delivers your ARM and sets your delegate.',
  'Voting power starts once you claim and delegate.',
  'Any USDC above your final allocation is refunded in the same transaction.',
] as const

const REFUND_KNOW_ITEMS = [
  'You’ll need a little ETH in this wallet for gas.',
  'Your full committed USDC is returned in one transaction.',
] as const

const ARM_INTRO_LEAD =
  'The crowdfund completed successfully. It’s time to claim your ARM tokens and set your delegate.'

const REFUND_INTRO_LEAD_MIN_FUND =
  'The crowdfund ended under the minimum fund, so no ARM was sold. Your full committed USDC is available to claim back.'

const REFUND_INTRO_LEAD_CANCELLED =
  'The sale was cancelled by the security council. Your full committed USDC is available to claim back.'

/** Loose ENS prefilter — drives the "should we kick off resolution?" branch.
 *  Strict charset validation lives in `isValidEnsName`; this looser check still
 *  treats partial typing like "alice.et" as not-yet-ENS. Mirrors SlotCard. */
function isEnsCandidate(val: string): boolean {
  return val.endsWith('.eth') && val.length > 4
}

function truncateMiddle(address: string, head = 6, tail = 4): string {
  if (address.length <= head + tail + 1) return address
  return `${address.slice(0, head)}…${address.slice(-tail)}`
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
  /** Optional ARM token address for the done-screen contract row. */
  armTokenAddress?: string | null
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
  /** Reports whether a claim tx is in flight, so the hosting modal can ask
   *  before Escape / its X closes it mid-claim. */
  onRunningChange?: (running: boolean) => void
  /** Close the flow in place (e.g. the Claim modal). Without it, the X and
   *  Done fall back to `onGoToNetwork`. */
  onClose?: () => void
  /** Reports whether the hosting modal should show its own X: gate screens
   *  draw none, every other screen has the in-card FlowChrome X. */
  onModalCloseChange?: (show: boolean) => void
}

/** The claim flow plus a stale-data warning above it. The Claim modal sits over
 *  the hero, which has no page-level StaleDataBanner of its own. */
export function ClaimFlowV2(props: ClaimFlowV2Props) {
  return (
    <>
      <StaleDataBanner />
      <ClaimFlowScreens {...props} />
    </>
  )
}

function ClaimFlowScreens(props: ClaimFlowV2Props) {
  const {
    walletConnected,
    isWrongNetwork,
    switchNetwork,
    walletAddress,
    signer,
    provider,
    crowdfundAddress,
    armTokenAddress,
    phase,
    refundMode,
    claimAvailable,
    claimCountdownSeconds,
    onGoToMyPosition,
    onGoToNetwork,
    onReceiptLogs,
    refreshAllowance,
    onRunningChange,
    onClose,
    onModalCloseChange,
  } = props

  const selfRadioId = useId()
  const otherRadioId = useId()
  const searchId = useId()
  const radioName = useId()

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
  const [delegateChoice, setDelegateChoice] = useState<DelegateChoice>('self')
  const [delegateScreen, setDelegateScreen] = useState<DelegateScreen>('choice')
  // Mirror of `delegate` so an in-flight ENS lookup can drop a stale result if
  // the user kept typing while it was resolving.
  const delegateRef = useRef(delegate)
  delegateRef.current = delegate
  // Set locally the instant a claim confirms, so the done screen shows without
  // waiting for the `claimed` read to refetch.
  const [justClaimed, setJustClaimed] = useState(false)
  const [claimTxHash, setClaimTxHash] = useState<string | null>(() => {
    const marker = getClaimInFlight(walletAddress)
    return marker?.hash ?? null
  })
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
  useEffect(() => {
    walletAddressRef.current = walletAddress
  }, [walletAddress])
  // Warn before a refresh/tab-close drops the user while a claim is broadcasting.
  useBeforeUnloadGuard(submitting)

  // Reconstruct in-progress state from a persisted in-flight claim marker, so
  // navigating away and back lands on "Submitting…" (or the eventual outcome)
  // rather than resetting to the intro — which looks un-submitted and
  // invites a duplicate claim. The marker is keyed by wallet address.
  const [step, setStep] = useState<FlowStep>(() =>
    getClaimInFlight(walletAddress) ? 'submit' : 'intro',
  )
  const [txs, setTxs] = useState<Step4Transaction[] | null>(() => {
    const marker = getClaimInFlight(walletAddress)
    if (!marker) return null
    const opLabel = marker.mode === 'arm' ? 'Claim ARM' : 'Claim USDC refund'
    return [
      {
        label: opLabel,
        status: 'loading',
        phaseLabel: 'Submitting…',
        hash: marker.hash,
        explorerUrl: getExplorerUrl(),
      },
    ]
  })

  // Decide claim mode based on contract state. Phase 2 (cancelled) → refund.
  // Phase 0 with refundMode (cappedDemand < min) → refund. Otherwise → ARM.
  // This mirrors v1 ClaimTab's mode derivation.
  const mode: ClaimMode = phase === 2 || refundMode ? 'refund' : 'arm'

  // Past the ARM claim deadline, `claim()` still succeeds but transfers ZERO ARM
  // (the allocation is forfeited on-chain) — only the over-cap USDC refund, if
  // any, still moves. Gate the ARM path so the UI never walks the user into a
  // claim showing ARM numbers it won't deliver. Refund-mode sales have no ARM and
  // no deadline, so this only applies to the ARM path.
  const armClaimWindowClosed =
    mode === 'arm' && props.claimDeadline > 0 && props.blockTimestamp > props.claimDeadline

  // Watch a reconstructed in-flight claim (from the marker) to its outcome.
  // Pure observation via the read provider — it never re-sends, so there's no
  // double-claim risk. Runs once per mount (the page is keyed by wallet address).
  useEffect(() => {
    const marker = getClaimInFlight(walletAddress)
    if (!marker || !provider) return
    let watchCancelled = false
    const opLabel = marker.mode === 'arm' ? 'Claim ARM' : 'Claim USDC refund'
    const explorerUrl = getExplorerUrl()
    provider
      .waitForTransaction(marker.hash, getTxConfirmations(), TX_WAIT_TIMEOUT_MS)
      .then((receipt) => {
        if (watchCancelled) return
        if (receipt && receipt.status === 1) {
          onReceiptLogs?.(receipt.logs as unknown as readonly ReceiptLogLike[])
          void refreshAllowance?.()
          clearClaimInFlight()
          setClaimTxHash(marker.hash)
          setJustClaimed(true)
          setStep('done')
          return
        }
        // status 0 = reverted. A wait-window timeout does NOT resolve here — ethers
        // v6 rejects it with a TIMEOUT error (handled in .catch below) rather than
        // resolving null. Surface an actionable error instead of a perpetual
        // "Submitting…"; the marker stays until Back/Retry acknowledges it.
        setTxs([
          {
            label: opLabel,
            status: 'error',
            errorMessage: 'Transaction reverted.',
            hash: marker.hash,
            explorerUrl,
          },
        ])
      })
      .catch((err) => {
        if (watchCancelled) return
        // ethers v6 rejects a `waitForTransaction` timeout with code 'TIMEOUT'. The
        // tx may still confirm later, so show a "still pending" error row instead of
        // stranding the user on "Submitting…". Any other rejection is a transient RPC
        // failure — leave the submitting state and let a later mount re-watch.
        if (isTxTimeoutError(err)) {
          setTxs([
            {
              label: opLabel,
              status: 'error',
              errorMessage: 'Still pending — it may still confirm. Check the explorer or retry.',
              hash: marker.hash,
              explorerUrl,
            },
          ])
        }
      })
    return () => {
      watchCancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, walletAddress])

  // Default delegate to the connected wallet address when it becomes available
  // (self-delegate), unless the user has already edited the field.
  useEffect(() => {
    if (hasUserEditedDelegate.current) return
    if (walletAddress && delegate === '' && delegateChoice === 'self') {
      // Display the raw address; resolve to the checksummed form internally.
      const checksummed = tryGetChecksumAddress(walletAddress)
      setDelegate(walletAddress)
      setResolvedDelegate(checksummed ?? '')
      setDelegateEns(checksummed ? 'resolved' : 'idle')
    }
  }, [walletAddress, delegate, delegateChoice])

  // Keep self-delegate resolved address in sync when choice is self.
  useEffect(() => {
    if (delegateChoice !== 'self') return
    if (!walletAddress) return
    if (hasUserEditedDelegate.current && delegateScreen === 'picker') return
    const checksummed = tryGetChecksumAddress(walletAddress)
    setDelegate(walletAddress)
    setResolvedDelegate(checksummed ?? '')
    setDelegateEns(checksummed ? 'resolved' : 'idle')
  }, [delegateChoice, walletAddress, delegateScreen])

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
      const [claimedRes, allocRes, committedRes] = await Promise.allSettled([
        contract.claimed(walletAddress) as Promise<boolean>,
        phase === 1
          ? (contract.computeAllocation(walletAddress) as Promise<[bigint, bigint]>)
          : Promise.resolve(null),
        // Sum the raw per-hop commitments. A cancelled sale (phase 2) can't
        // `computeAllocation` (it reverts), so this makes its refund gate + amount
        // contract-authoritative rather than indexer-derived — the indexer lags on
        // a cold load and would otherwise flash a false "no refund to claim". In
        // every phase it is also the "Final commit" the intro screens show.
        Promise.all(
          HOP_CONFIGS.map((_, h) => contract.getCommitment(walletAddress, h) as Promise<bigint>),
        ),
      ])
      const hasClaimed = claimedRes.status === 'fulfilled' ? claimedRes.value : false
      let armAmount = 0n
      let refundAmount = 0n
      // Null when the commitment read failed outside phase 2, where it is
      // display-only — "Final commit" then falls back to the indexer total.
      let committedTotal: bigint | null = null
      let readError = false
      if (phase === 1) {
        if (allocRes.status === 'fulfilled' && allocRes.value) {
          armAmount = allocRes.value[0]
          refundAmount = allocRes.value[1]
        } else if (allocRes.status === 'rejected') {
          readError = true
        }
      }
      if (committedRes.status === 'fulfilled') {
        committedTotal = committedRes.value.reduce((sum, c) => sum + c, 0n)
      } else if (phase === 2) {
        readError = true
      }
      return { hasClaimed, armAmount, refundAmount, committedTotal, readError }
    },
  })

  const reads = claimQuery.data ?? {
    hasClaimed: false,
    armAmount: 0n,
    refundAmount: 0n,
    committedTotal: null,
    readError: false,
  }
  const hasClaimed = reads.hasClaimed || justClaimed
  const armAmount = reads.armAmount
  const refundAmount = reads.refundAmount
  const readError = reads.readError
  // `loading` only while an enabled query has no data yet (false when disabled,
  // so the gate states render). An account switch re-keys the query → loading.
  const loading = claimReadsEnabled && claimQuery.isPending

  // Contract-authoritative USDC the user can claim back on the refund path: a
  // cancelled sale (phase 2) refunds the full raw commitment (summed above); a
  // finalized refund-mode sale returns it as `computeAllocation`'s refund. Using
  // this instead of the indexer-derived `totalCommitted` fixes both the false
  // "no refund" flash on a cold load and the over-cap understatement (claimRefund
  // returns the raw deposit, which the capped graph value understates).
  const refundClaimable = phase === 2 ? (reads.committedTotal ?? 0n) : refundAmount

  // What the user actually gets back.
  const armDisplay = useMemo(() => formatArm(armAmount), [armAmount])
  const refundDisplay = useMemo(
    () => formatUsdc(mode === 'refund' ? refundClaimable : refundAmount),
    [mode, refundClaimable, refundAmount],
  )
  // The raw on-chain commitment, so it squares with the ARM + refund shown beside
  // it. The indexer total is capped and lags on a cold load — fallback only.
  const finalCommitDisplay = useMemo(
    () => formatUsdc(reads.committedTotal ?? props.totalCommitted),
    [reads.committedTotal, props.totalCommitted],
  )

  const walletDisplay =
    walletAddress != null ? truncateAddress(walletAddress) : null

  const effectiveDelegateLabel =
    delegateChoice === 'self'
      ? walletDisplay
      : delegateEns === 'resolved' && resolvedDelegate
        ? isValidEnsName(delegate)
          ? delegate
          : truncateAddress(resolvedDelegate)
        : null

  // In flight while sending, or while a row (incl. one rebuilt from the
  // in-flight marker after a remount) is still waiting on the chain.
  const claimInFlight = submitting || (txs?.some((t) => t.status === 'loading') ?? false)
  useEffect(() => {
    onRunningChange?.(claimInFlight)
  }, [claimInFlight, onRunningChange])
  useEffect(() => () => onRunningChange?.(false), [onRunningChange])

  const handleClose = () => {
    if (!confirmClaimClose(claimInFlight)) return
    if (onClose) onClose()
    else onGoToNetwork()
  }

  // Mirrors the gate early returns below (a claimed wallet's done screen wins
  // over a read error). Gate screens have no in-card X, so the modal shows its.
  const onGateScreen =
    !walletConnected ||
    !claimAvailable ||
    loading ||
    (!hasClaimed && step !== 'done' && readError)
  useEffect(() => {
    onModalCloseChange?.(onGateScreen)
    return () => onModalCloseChange?.(true)
  }, [onGateScreen, onModalCloseChange])

  // Submit the claim/refund transaction through the shared single-step engine,
  // so it inherits the two-phase labels, explorer link, and quiet-rejection
  // handling. Updates `txs` so WalletConfirmStep / Step4Approve renders controlled status.
  const runClaim = async () => {
    if (runningRef.current) return
    // Past the deadline the ARM path claims only the USDC refund — label it honestly.
    const opLabel =
      mode === 'arm' && !armClaimWindowClosed ? 'Claim ARM' : 'Claim USDC refund'
    if (!crowdfundAddress) {
      // Surface an error row instead of bailing into a neutral state.
      setTxs([
        {
          label: opLabel,
          status: 'error',
          errorMessage: 'Still loading the crowdfund — try again in a moment.',
        },
      ])
      return
    }
    // Submit the canonical checksummed delegate — `resolvedDelegate` is set by
    // handleDelegateChange (from ENS resolution or a direct 0x… entry). Fall
    // back to checksumming the raw input as a defense-in-depth backstop.
    const delegateAddress = resolvedDelegate || tryGetChecksumAddress(delegate)
    // Past the ARM claim deadline the contract skips delegation entirely (ARM is
    // forfeited), so no delegate is required — the claim returns only the USDC
    // refund. Don't block that refund-only claim on delegate validation.
    if (
      mode === 'arm' &&
      !armClaimWindowClosed &&
      (!delegateAddress || delegateAddress === ZeroAddress)
    ) {
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
        // submitWrite routes mobile through wagmi (so MetaMask Mobile surfaces the
        // request) and desktop through ethers after asserting the wallet is on the
        // hub chain.
        return mode === 'arm'
          ? submitWrite(crowdfund, 'claim', [delegateAddress!], activeSigner)
          : submitWrite(crowdfund, 'claimRefund', [], activeSigner)
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
        // Page-owned marker so a remount mid-flight reconstructs this tx's state.
        setClaimInFlight({ hash, mode, address: startAddress ?? '', sentAt: Date.now() })
        setClaimTxHash(hash)
        setTxs([
          { label: opLabel, status: 'loading', phaseLabel: 'Submitting…', hash, explorerUrl },
        ])
      },
      // Race the direct read provider against the wallet's tx.wait() so the done
      // screen lands as soon as the chain confirms, instead of waiting on the
      // wallet provider's slower poll (which lagged the header chip by seconds).
      provider,
    )
    runningRef.current = false
    setSubmitting(false)

    // A resolved tx no longer needs watching; a timed-out one may still confirm,
    // so it stays persisted for the post-timeout watcher. Mirrors the commit pipeline.
    if (result.hash && result.outcome !== 'timeout') removePendingTx(result.hash)

    if (result.outcome === 'success') {
      setTxs([{ label: opLabel, status: 'done', hash: result.hash, explorerUrl }])
      clearClaimInFlight()
      if (result.hash) setClaimTxHash(result.hash)
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
      setStep(mode === 'refund' ? 'intro' : 'review')
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
        <GateShell title="Wrong network">
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
        </GateShell>
      )
    }
    return (
      <GateShell title="Connect your wallet to claim">
        <p className={styles.gateBody}>
          Once the campaign finalizes you&apos;ll be able to claim ARM tokens (or a USDC refund)
          from here.
        </p>
      </GateShell>
    )
  }

  if (!claimAvailable) {
    return (
      <GateShell title="Claiming isn't open yet">
        <p className={styles.gateBody}>
          You&apos;ll be able to claim ARM tokens (or a USDC refund if the sale ends below the
          minimum fund) from here.
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
      </GateShell>
    )
  }

  if (loading) {
    return (
      <GateShell title="Loading allocation…">
        <p className={styles.gateBody}>Fetching your share of the sale.</p>
      </GateShell>
    )
  }

  // Already-claimed: short-circuit to the done state. Same surface as a
  // freshly-completed claim so the user always sees a coherent end-of-flow.
  if (hasClaimed || step === 'done') {
    return (
      <DoneScreen
        mode={mode}
        armForfeited={armClaimWindowClosed}
        armDisplay={armDisplay}
        refundDisplay={refundDisplay}
        refundAmount={refundAmount}
        armTokenAddress={armTokenAddress ?? null}
        claimTxHash={claimTxHash}
        walletAddress={walletAddress}
        onClose={handleClose}
      />
    )
  }

  // Allocation read failed (RPC error, not a contract "no allocation"). Don't
  // render a misleading "0 ARM" — offer a retry.
  if (readError) {
    return (
      <GateShell title="Couldn't load your allocation">
        <p className={styles.gateBody}>Something went wrong fetching your share. Try again.</p>
        <div className={styles.gateActions}>
          <ArmadaButton
            variant="secondary"
            size="md"
            label="Retry"
            showIcon={false}
            onClick={() => void claimQuery.refetch()}
          />
        </div>
      </GateShell>
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
        <GateShell title="Sale ended below minimum">
          <p className={styles.gateBody}>
            {props.totalCommitted > 0n
              ? `The crowdfund didn't reach the ${formatUsdc(CROWDFUND_CONSTANTS.MIN_SALE)} minimum fund. Once it's finalized, you'll be able to claim a refund of your committed ${formatUsdc(props.totalCommitted)} from here.`
              : `The crowdfund didn't reach the ${formatUsdc(CROWDFUND_CONSTANTS.MIN_SALE)} minimum fund. Once it's finalized, all committed USDC will be refundable to the addresses that participated.`}
          </p>
          <p className={styles.gateBodyFootnote}>
            Finalization is permissionless — anyone can trigger it. Refresh this page once
            it&apos;s done.
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
        </GateShell>
      )
    }
    return (
      <GateShell title="Awaiting finalization">
        <p className={styles.gateBody}>
          The commit window has closed. Once the sale is finalized you&apos;ll be able to claim
          your ARM allocation (and any USDC refund for over-cap commitments) from here.
        </p>
        <p className={styles.gateBodyFootnote}>
          Finalization is permissionless — anyone can trigger it. Refresh this page once
          it&apos;s done.
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
      </GateShell>
    )
  }

  // No allocation: don't show the submit path at all. Reaches here only after
  // the sale has been finalized successfully — the connected address
  // genuinely has nothing to claim (didn't commit, or committed under a
  // different wallet).
  const armNothing = mode === 'arm' && armAmount === 0n && refundAmount === 0n
  const refundNothing = mode === 'refund' && refundClaimable === 0n
  if ((armNothing || refundNothing) && step !== 'submit') {
    return (
      <NothingToClaimScreen
        mode={mode}
        walletAddress={walletAddress}
        onGoToMyPosition={onGoToMyPosition}
        onGoToNetwork={onGoToNetwork}
        onClose={handleClose}
      />
    )
  }

  // Past the ARM claim deadline: ARM is forfeited on-chain. Offer only the USDC
  // refund (if any) rather than the normal ARM intro/delegate/review, which would
  // show ARM numbers the claim won't deliver. Skip while submit is in flight.
  if (armClaimWindowClosed && step !== 'submit') {
    const hasRefund = refundAmount > 0n
    return (
      <GateShell title="ARM claim window closed">
        <p className={styles.gateBody}>
          The window to claim your ARM allocation has closed, so the ARM is forfeited.
          {hasRefund
            ? ` You can still claim your USDC refund of ${formatUsdc(refundAmount)} from over-cap commitments.`
            : ' There is nothing left to claim.'}
        </p>
        <div className={styles.gateActions}>
          {hasRefund && (
            <ArmadaButton
              variant="primary"
              size="md"
              label={`Claim ${formatUsdc(refundAmount)} refund`}
              showIcon={false}
              disabled={submitting}
              onClick={() => {
                setTxs(null)
                setStep('submit')
                void runClaim()
              }}
            />
          )}
          <ArmadaButton
            variant="secondary"
            size="md"
            label="Back to crowdfund"
            showIcon={false}
            onClick={onGoToNetwork}
          />
        </div>
      </GateShell>
    )
  }

  // ── Active flow ─────────────────────────────────────────────────

  if (step === 'submit') {
    const walletTxs = (txs ?? [
      {
        label: mode === 'refund' ? `Claim ${refundDisplay} refund` : 'Claim ARM',
        status: 'loading' as const,
        phaseLabel: 'Confirm in your wallet…',
      },
    ]).map((t) => ({
      label: t.label,
      status: t.status,
      errorMessage: t.errorMessage,
      errorDetails: t.errorDetails,
      phaseLabel: t.phaseLabel,
      hash: t.hash,
      explorerUrl: t.explorerUrl,
    }))

    return (
      <CardFlowShell
        title="Confirm"
        // No chrome Back: mid-flight it would hide a later revert/timeout and drop
        // the in-flight marker. Once a row errors, WalletConfirmStep's footer
        // offers Back + Retry.
        showBack={false}
        onClose={handleClose}
      >
        <WalletConfirmStep
          transactions={walletTxs}
          onBack={() => {
            clearClaimInFlight()
            setTxs(null)
            setStep(mode === 'refund' ? 'intro' : 'review')
          }}
          onRetry={() => {
            clearClaimInFlight()
            setTxs(null)
            void runClaim()
          }}
        />
      </CardFlowShell>
    )
  }

  if (step === 'intro' && mode === 'refund') {
    const refundLead =
      phase === 2 ? REFUND_INTRO_LEAD_CANCELLED : REFUND_INTRO_LEAD_MIN_FUND

    return (
      <CardFlowShell
        title="Claim your USDC refund"
        titleId="claim-intro-title"
        titleAlign="start"
        showBack={false}
        onClose={handleClose}
      >
        <div className={styles.introWrap}>
          <div className={styles.introScroll}>
            <p className={styles.introLead}>{refundLead}</p>

            <div className={styles.factsCard}>
              <div className={styles.factRow}>
                <span className={styles.factLabel}>USDC refund</span>
                <span className={styles.factValueAccent}>{refundDisplay}</span>
              </div>
              <div className={styles.divider} aria-hidden />
              <div className={styles.factRow}>
                <span className={styles.factLabel}>Final commit</span>
                <span className={styles.factValue}>{finalCommitDisplay}</span>
              </div>
            </div>

            <section className={styles.knowBlock} aria-labelledby="claim-intro-know">
              <h3 id="claim-intro-know" className={styles.knowHeading}>
                What to know
              </h3>
              <ul className={styles.knowList}>
                {REFUND_KNOW_ITEMS.map((text) => (
                  <li key={text} className={styles.knowItem}>
                    <span className={styles.knowBullet} aria-hidden>
                      ·
                    </span>
                    <span>{text}</span>
                  </li>
                ))}
              </ul>
            </section>
          </div>
          <div className={styles.introFade} aria-hidden />
        </div>
        <div className={styles.buttonRow}>
          <ArmadaButton
            variant="primary"
            size="lg"
            label={`Claim ${refundDisplay} refund`}
            showIcon={false}
            disabled={submitting}
            onClick={() => {
              setTxs(null)
              setStep('submit')
              void runClaim()
            }}
          />
        </div>
      </CardFlowShell>
    )
  }

  if (step === 'intro') {
    return (
      <CardFlowShell
        title="Claim your ARM tokens"
        titleId="claim-intro-title"
        titleAlign="start"
        showBack={false}
        onClose={handleClose}
      >
        <div className={styles.introWrap}>
          <div className={styles.introScroll}>
            <p className={styles.introLead}>{ARM_INTRO_LEAD}</p>

            <div className={styles.factsCard}>
              <div className={styles.factRow}>
                <span className={styles.factLabel}>ARM allocation</span>
                <span className={styles.factValueAccent}>{armDisplay}</span>
              </div>
              <div className={styles.divider} aria-hidden />
              <div className={styles.factRow}>
                <span className={styles.factLabel}>Final commit</span>
                <span className={styles.factValue}>{finalCommitDisplay}</span>
              </div>
            </div>

            <section className={styles.knowBlock} aria-labelledby="claim-intro-how">
              <h3 id="claim-intro-how" className={styles.knowHeading}>
                How to claim
              </h3>
              <ol className={styles.stepCards} aria-labelledby="claim-intro-how">
                {ARM_CLAIM_STEPS.map((item, index) => (
                  <li key={item.label} className={styles.stepCard}>
                    <span className={styles.stepNumber} aria-hidden>
                      {index + 1}
                    </span>
                    <div className={styles.stepCopy}>
                      <span className={styles.stepLabel}>{item.label}</span>
                      <span className={styles.stepHint}>{item.hint}</span>
                    </div>
                  </li>
                ))}
              </ol>
            </section>

            <section className={styles.knowBlock} aria-labelledby="claim-intro-know">
              <h3 id="claim-intro-know" className={styles.knowHeading}>
                What to know
              </h3>
              <ul className={styles.knowList}>
                {ARM_KNOW_ITEMS.map((text) => (
                  <li key={text} className={styles.knowItem}>
                    <span className={styles.knowBullet} aria-hidden>
                      ·
                    </span>
                    <span>{text}</span>
                  </li>
                ))}
              </ul>
            </section>
          </div>
          <div className={styles.introFade} aria-hidden />
        </div>
        <div className={styles.buttonRow}>
          <ArmadaButton
            variant="primary"
            size="lg"
            label="Start"
            showIcon={false}
            onClick={() => {
              setDelegateScreen('choice')
              setStep('delegate')
            }}
          />
        </div>
      </CardFlowShell>
    )
  }

  if (step === 'delegate' && mode === 'arm') {
    if (delegateScreen === 'picker') {
      const canReview = delegateEns === 'resolved' && resolvedDelegate !== ''
      return (
        <CardFlowShell
          title="Select a delegate"
          onBack={() => setDelegateScreen('choice')}
          onClose={handleClose}
        >
          <div className={[styles.cardContent, styles.cardContentFill].join(' ')}>
            <div className={styles.delegatePicker}>
              <div className={styles.searchField}>
                <MagnifyingGlassIcon className={styles.searchIcon} aria-hidden />
                <input
                  id={searchId}
                  type="search"
                  autoComplete="off"
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  maxLength={ADDRESS_INPUT_MAX_LENGTH}
                  placeholder="Name or address"
                  value={delegate}
                  onChange={(e) => void handleDelegateChange(e.target.value)}
                  className={styles.searchInput}
                  aria-label="Search delegates"
                />
              </div>
              {delegateEns === 'resolving' && (
                <p className={styles.delegateHelp}>Resolving ENS…</p>
              )}
              {delegateEns === 'resolved' && resolvedDelegate && (
                <div className={styles.delegateResolvedCard} role="status">
                  <span className={styles.delegateResolvedPrimary}>
                    {isValidEnsName(delegate) ? delegate : truncateAddress(resolvedDelegate)}
                  </span>
                  <span className={styles.delegateResolvedSecondary}>
                    {isValidEnsName(delegate)
                      ? truncateAddress(resolvedDelegate)
                      : 'Ready to delegate'}
                  </span>
                </div>
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
              {delegateEns === 'idle' && !delegate && (
                <p className={styles.delegateHelp}>
                  Enter a 0x address or ENS name (name.eth) to assign your voting power.
                </p>
              )}
            </div>
          </div>
          <div className={styles.buttonRow}>
            <ArmadaButton
              variant="primary"
              size="lg"
              label="Review"
              showIcon={false}
              className={!canReview ? styles.ctaBlocked : undefined}
              aria-disabled={!canReview || undefined}
              onClick={() => {
                if (!canReview) return
                setStep('review')
              }}
            />
          </div>
        </CardFlowShell>
      )
    }

    return (
      <CardFlowShell
        title="Choose your delegate"
        onBack={() => {
          setDelegateScreen('choice')
          setStep('intro')
        }}
        onClose={handleClose}
      >
        <div className={styles.cardContent}>
          <fieldset className={styles.radioGroup}>
            <legend className={styles.visuallyHidden}>Delegation preference</legend>

            <label
              className={[
                styles.radioOption,
                delegateChoice === 'self' && styles.radioOptionSelected,
              ]
                .filter(Boolean)
                .join(' ')}
              htmlFor={selfRadioId}
            >
              <input
                id={selfRadioId}
                className={styles.radioInput}
                type="radio"
                name={radioName}
                checked={delegateChoice === 'self'}
                onChange={() => {
                  hasUserEditedDelegate.current = false
                  setDelegateChoice('self')
                  setSelectedSelf(walletAddress, setDelegate, setResolvedDelegate, setDelegateEns)
                }}
              />
              <span className={styles.radioCopy}>
                <span className={styles.radioTitle}>Keep voting powers</span>
                <span className={styles.radioHint}>
                  Self-delegate — you vote with the ARM claimed to this wallet.
                </span>
              </span>
            </label>

            <label
              className={[
                styles.radioOption,
                delegateChoice === 'other' && styles.radioOptionSelected,
              ]
                .filter(Boolean)
                .join(' ')}
              htmlFor={otherRadioId}
            >
              <input
                id={otherRadioId}
                className={styles.radioInput}
                type="radio"
                name={radioName}
                checked={delegateChoice === 'other'}
                onChange={() => {
                  setDelegateChoice('other')
                  hasUserEditedDelegate.current = true
                  setDelegate('')
                  setResolvedDelegate('')
                  setDelegateEns('idle')
                }}
              />
              <span className={styles.radioCopy}>
                <span className={styles.radioTitle}>Delegate vote</span>
                <span className={styles.radioHint}>
                  Assign voting power to another address that can vote on your behalf.
                </span>
              </span>
            </label>
          </fieldset>
        </div>
        <div className={styles.buttonRow}>
          <ArmadaButton
            variant="primary"
            size="lg"
            label={delegateChoice === 'other' ? 'Continue' : 'Review'}
            showIcon={false}
            onClick={() => {
              if (delegateChoice === 'other') {
                setDelegateScreen('picker')
                return
              }
              setStep('review')
            }}
          />
        </div>
      </CardFlowShell>
    )
  }

  // ARM review (refund skips review — the claim CTA lives on the intro)
  const armHasRefund = refundAmount > 0n
  return (
    <CardFlowShell
      title="Review claim"
      onBack={() => {
        setDelegateScreen(delegateChoice === 'other' ? 'picker' : 'choice')
        setStep('delegate')
      }}
      onClose={handleClose}
    >
      <div className={styles.cardContent}>
        <div className={styles.summaryCard}>
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
          <div className={styles.divider} />
          <div className={styles.summaryRow}>
            <span className={styles.summaryLabel}>
              {delegateChoice === 'self' ? 'Self-delegate' : 'Delegate'}
            </span>
            <span className={styles.summaryValue}>{effectiveDelegateLabel}</span>
          </div>
          {armHasRefund ? (
            <>
              <div className={styles.divider} />
              <div className={styles.summaryRow}>
                <span className={styles.summaryLabel}>USDC refund</span>
                <span className={styles.summaryValue}>{formatUsdc(refundAmount)}</span>
              </div>
            </>
          ) : null}
        </div>
        <div className={styles.warningBlock}>
          <p className={styles.warningText}>
            {armHasRefund
              ? 'A single transaction delivers your ARM and your USDC refund.'
              : 'A single transaction delivers your ARM and sets your delegate.'}
          </p>
        </div>
      </div>
      <div className={styles.buttonRow}>
        <ArmadaButton
          variant="primary"
          size="lg"
          label="Claim ARM"
          showIcon={false}
          disabled={
            submitting ||
            !(delegateEns === 'resolved' && resolvedDelegate !== '')
          }
          onClick={() => {
            setTxs(null)
            setStep('submit')
            void runClaim()
          }}
        />
      </div>
    </CardFlowShell>
  )
}

function setSelectedSelf(
  walletAddress: string | null,
  setDelegate: (v: string) => void,
  setResolvedDelegate: (v: string) => void,
  setDelegateEns: (v: DelegateEnsState) => void,
) {
  if (!walletAddress) {
    setDelegate('')
    setResolvedDelegate('')
    setDelegateEns('idle')
    return
  }
  const checksummed = tryGetChecksumAddress(walletAddress)
  setDelegate(walletAddress)
  setResolvedDelegate(checksummed ?? '')
  setDelegateEns(checksummed ? 'resolved' : 'idle')
}

// ── Helpers ──────────────────────────────────────────────────────

function GateShell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className={styles.gateShell}>
      <h2 className={styles.gateTitle}>{title}</h2>
      {children}
    </div>
  )
}

function CardFlowShell({
  title,
  titleId,
  titleAlign = 'center',
  onBack,
  onClose,
  showBack = true,
  children,
}: {
  title?: ReactNode
  titleId?: string
  titleAlign?: 'center' | 'start'
  onBack?: () => void
  onClose?: () => void
  showBack?: boolean
  children: ReactNode
}) {
  return (
    <div className={styles.flowShell}>
      <div className={styles.cardShell}>
        <FlowChrome
          title={title}
          titleId={titleId}
          titleAlign={titleAlign}
          showBack={showBack && !!onBack}
          onBack={onBack}
          onClose={onClose}
          closeAriaLabel="Close claim flow"
        />
        {children}
      </div>
    </div>
  )
}

function NothingToClaimScreen({
  mode,
  walletAddress,
  onGoToMyPosition,
  onGoToNetwork,
  onClose,
}: {
  mode: ClaimMode
  walletAddress: string | null
  onGoToMyPosition: () => void
  onGoToNetwork: () => void
  onClose: () => void
}) {
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
        {shortAddress} didn&apos;t commit any USDC to the sale.
        <br />
        You may have committed with a different wallet.
      </>
    ) : (
      <>This address didn&apos;t commit any USDC to the sale.</>
    )
  const nextText =
    mode === 'arm'
      ? 'If you committed but expected an allocation here, switch to the wallet you used to commit and reload the claim page.'
      : 'If you expected a refund here, switch to the wallet you used to commit and reload the claim page.'

  return (
    <CardFlowShell title="Claim" showBack={false} onClose={onClose}>
      <div className={styles.cardContent}>
        <div className={styles.heroBlock}>
          <h2 className={styles.headline}>{headline}</h2>
          <p className={styles.subline}>{subline}</p>
        </div>
        <div className={styles.nextCard}>
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
          variant="primary"
          size="lg"
          label="View my position"
          showIcon={false}
          onClick={onGoToMyPosition}
        />
      </div>
    </CardFlowShell>
  )
}

/** Table value that links to the block explorer when one is configured, else plain text. */
function ExplorerValue({
  href,
  display,
  fullValue,
}: {
  href: string | null
  display: string
  fullValue: string
}) {
  if (!href) {
    return (
      <span className={styles.factValue} title={fullValue}>
        {display}
      </span>
    )
  }
  return (
    <a
      className={styles.factValueLink}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={fullValue}
    >
      {display}
      <span className={styles.visuallyHidden}> (opens in a new tab)</span>
    </a>
  )
}

function DoneScreen({
  mode,
  armForfeited,
  armDisplay,
  refundDisplay,
  refundAmount,
  armTokenAddress,
  claimTxHash,
  walletAddress,
  onClose,
}: {
  mode: ClaimMode
  /** The ARM claim deadline has passed — `claim()` delivered no ARM (forfeited),
   *  only the USDC refund (if any). Suppresses the "ARM is in your wallet" copy.
   *  Stays neutral rather than asserting "forfeited": a user who claimed in time
   *  but revisits after the deadline is also `hasClaimed`, and `claimed` alone
   *  can't tell us which. */
  armForfeited: boolean
  armDisplay: string
  refundDisplay: string
  /** Over-cap USDC refund delivered by the ARM `claim()` call. Used to swap in
   *  the "ARM + USDC refund" copy when applicable; ignored for `mode='refund'`
   *  (the refund there is the whole `refundDisplay`). */
  refundAmount: bigint
  armTokenAddress: string | null
  claimTxHash: string | null
  /** Connected wallet — the destination address row links to the explorer. */
  walletAddress: string | null
  onClose: () => void
}) {
  // Same headline on first-success and on revisit — the action is idempotent
  // from the user's perspective, and "You already claimed" reads like an
  // error. Past-tense success copy works for both cases.
  const armHasRefund = mode === 'arm' && refundAmount > 0n
  const armForfeitedPath = mode === 'arm' && armForfeited
  const headline =
    mode === 'arm'
      ? armForfeited
        ? 'Claim complete.'
        : 'ARM claimed.'
      : 'USDC refund claimed'
  const subline = armForfeitedPath ? (
    // Past the deadline: never assert ARM landed. Show the refund if there was one.
    armHasRefund ? (
      <>{refundDisplay} USDC refund returned to your wallet.</>
    ) : (
      <>Your claim has settled on-chain.</>
    )
  ) : mode === 'arm' ? (
    armHasRefund ? (
      <>
        {armDisplay} is in your wallet.
        <br />
        {refundDisplay} USDC refund returned too.
      </>
    ) : (
      <>Your ARM is settled on-chain and your delegate is active.</>
    )
  ) : (
    <>Your USDC refund is settled on-chain.</>
  )

  const explorerBase = getExplorerUrl()
  const addressHref = (address: string) =>
    explorerBase ? `${explorerBase}/address/${address}` : null
  const txHref = (hash: string) => (explorerBase ? `${explorerBase}/tx/${hash}` : null)

  // Single summary table: amount → destination (claim only) → tx hash → ARM contract.
  const amountRows: Array<{ label: string; value: string }> = []
  if (armForfeitedPath) {
    if (armHasRefund) amountRows.push({ label: 'Amount claimed', value: `${refundDisplay} USDC` })
  } else if (mode === 'arm') {
    amountRows.push({ label: 'Amount claimed', value: armDisplay })
    if (armHasRefund) amountRows.push({ label: 'USDC refund', value: `${refundDisplay} USDC` })
  } else {
    amountRows.push({ label: 'Amount claimed', value: `${refundDisplay} USDC` })
  }

  type FactRow = { key: string; label: string; content: ReactNode }
  const rows: FactRow[] = amountRows.map((r) => ({
    key: r.label,
    label: r.label,
    content: <span className={styles.factValueAccent}>{r.value}</span>,
  }))
  if (walletAddress) {
    rows.push({
      key: 'destination',
      label: 'Destination address',
      content: (
        <ExplorerValue
          href={addressHref(walletAddress)}
          display={truncateMiddle(walletAddress)}
          fullValue={walletAddress}
        />
      ),
    })
  }
  if (claimTxHash) {
    rows.push({
      key: 'tx',
      label: 'Tx hash',
      content: (
        <ExplorerValue
          href={txHref(claimTxHash)}
          display={truncateMiddle(claimTxHash)}
          fullValue={claimTxHash}
        />
      ),
    })
  }
  if (mode === 'arm' && armTokenAddress && !armForfeitedPath) {
    rows.push({
      key: 'arm-contract',
      label: 'ARM contract address',
      content: (
        <ExplorerValue
          href={addressHref(armTokenAddress)}
          display={truncateMiddle(armTokenAddress)}
          fullValue={armTokenAddress}
        />
      ),
    })
  }

  return (
    <CardFlowShell
      showBack={false}
      titleAlign="start"
      titleId="claim-done-title"
      title={
        <>
          <CheckCircleIcon className={styles.successIcon} aria-hidden />
          {headline}
        </>
      }
      onClose={onClose}
    >
      <div className={styles.introWrap}>
        <div className={styles.introScroll}>
          <p className={styles.introLead}>{subline}</p>

          {rows.length > 0 ? (
            <div className={styles.factsCard}>
              {rows.map((row, i) => (
                <Fragment key={row.key}>
                  {i > 0 ? <div className={styles.divider} aria-hidden /> : null}
                  <div className={styles.factRow}>
                    <span className={styles.factLabel}>{row.label}</span>
                    {row.content}
                  </div>
                </Fragment>
              ))}
            </div>
          ) : null}

          <UsefulLinks headingId="claim-done-useful-links" />
        </div>
        <div className={styles.introFade} aria-hidden />
      </div>
      <div className={styles.buttonRow}>
        <ArmadaButton
          variant="primary"
          size="lg"
          label="Done"
          showIcon={false}
          onClick={onClose}
        />
      </div>
    </CardFlowShell>
  )
}
