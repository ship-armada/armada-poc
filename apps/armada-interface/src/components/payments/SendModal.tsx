// ABOUTME: SendModal — pay someone in USDC, either privately (0zk → 0zk) or to an external wallet (0x). Picks among three kinds based on the tab + destination chain.
// ABOUTME: Mounts three useTx hooks (transfer-shielded / unshield-local / unshield-xchain); submitted-kind state locks the subscription for the rest of the flow. External-tab + xchain reuses unshield-xchain — same contract path, different UI entry.

import { useEffect, useRef, useState } from 'react'
import { useAtom, useAtomValue } from 'jotai'
import { openModalAtom } from '@/state/ui'
import { preferencesAtom } from '@/state/preferences'
import { shieldedUsdcAtom } from '@/state/wallet'
import { useTx } from '@/hooks/useTx'
import { useFees } from '@/hooks/useFees'
import { useSpendableSyncGate } from '@/hooks/useSpendableSyncGate'
import { getNetworkConfig } from '@/config/network'
import {
  findDeploymentForChain,
  loadDeployments,
  type ResolvedDeployments,
} from '@/config/deployments'
import { parseUsdcInput } from '@/lib/format'
import { cctpFastFeeForAmount, computeFeeBreakdown, userFeeForKind } from '@/lib/relayer'
import { isShieldedAddress, validateShieldedAddressStrict } from '@/lib/address'
import { displayTxHash, txExplorerUrl } from '@/lib/explorer'
import { trackError } from '@/lib/telemetry'
import {
  overlayIndicatorStep,
  overlayIndicatorStatus,
  ProgressStep,
  ErrorStep,
  type FlowStep,
  type FlowVisibleStep,
} from '@/components/flow'
import { DepositOverlayShell } from '@/components/deposit/DepositOverlayShell/DepositOverlayShell'
import { SendInputStepContent, SendInputStepFooter, type SendTab } from './SendInputStep'
import { useDisplayFees } from '@/hooks/useDisplayFees'
import { SendReviewStep } from './SendReviewStep'
import { SendCompleteStep } from './SendCompleteStep'
import { RelayerStatusBanner } from '@/components/RelayerStatusBanner'

type LocalStep = FlowStep

type SubmittedKind = 'transfer-shielded' | 'unshield-local' | 'unshield-xchain'

function computeKind(tab: SendTab, destChainId: number, hubChainId: number): SubmittedKind {
  if (tab === 'private') return 'transfer-shielded'
  return destChainId === hubChainId ? 'unshield-local' : 'unshield-xchain'
}

export function SendModal() {
  const [openModal, setOpenModal] = useAtom(openModalAtom)
  const isOpen = openModal === 'payment'
  // A6 — frozen into the record's meta at submit-time so a mid-flight toggle doesn't strand the handler.
  const prefs = useAtomValue(preferencesAtom)

  // Form state
  const hubChainId = getNetworkConfig().hub.chainId
  const [tab, setTab] = useState<SendTab>('private')
  const [destChainId, setDestChainId] = useState<number>(hubChainId)
  const [recipient, setRecipient] = useState<string>('')
  const [amountStr, setAmountStr] = useState<string>('')

  // Flow state
  const [step, setStep] = useState<LocalStep>('input')
  const [errorAtStep, setErrorAtStep] = useState<FlowVisibleStep | undefined>(undefined)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [submittedKind, setSubmittedKind] = useState<SubmittedKind | null>(null)
  // Double-submit guard (P0-7): ref = synchronous gate (state is async), state = button disable.
  const submittingRef = useRef(false)
  const [isSubmitting, setIsSubmitting] = useState(false)

  // Source data
  const shieldedUsdc = useAtomValue(shieldedUsdcAtom)
  const max = shieldedUsdc ?? 0n
  const { value: amount } = parseUsdcInput(amountStr)
  const { quote, isStale, refresh } = useFees()
  // Gate Confirm while the initial shielded-balance sync is incomplete. Both Send tabs
  // (private + external) spend the user's shielded USDC, so the same gate applies.
  const syncGate = useSpendableSyncGate()

  // Deployment manifests — used to validate that the chosen destination chain actually has a
  // deployment present. Otherwise the user could pick a chain that the submit step would throw on.
  const [deployments, setDeployments] = useState<ResolvedDeployments | null>(null)
  useEffect(() => {
    if (!isOpen) return
    let cancelled = false
    void loadDeployments()
      .then(d => { if (!cancelled) setDeployments(d) })
      .catch(err => {
        // Leave `deployments` null — `destHasDeployment` below stays `true` until the manifest
        // is known, so the user can still proceed through the form; the submit step's own
        // error path will surface the real failure if it persists. Telemetry is the only signal
        // we have here, since the user wouldn't otherwise know loadDeployments tried and failed.
        trackError('SendModal.loadDeployments', err, {
          scope: 'send.deployments',
          message: 'failed to load deployment manifests for destination-chain check',
        })
      })
    return () => { cancelled = true }
  }, [isOpen])
  const destHasDeployment =
    tab === 'private' || !deployments
      ? true
      : findDeploymentForChain(deployments, destChainId) !== undefined
  const destDeploymentError = destHasDeployment
    ? undefined
    : 'This destination chain has no deployment manifest. Pick another chain.'

  // Three useTx hooks mounted; only one gets a record per flow.
  const txTransfer = useTx({ kind: 'transfer-shielded' })
  const txUnshieldLocal = useTx({ kind: 'unshield-local' })
  const txUnshieldXchain = useTx({ kind: 'unshield-xchain' })

  const activeTx =
    submittedKind === 'transfer-shielded' ? txTransfer
    : submittedKind === 'unshield-local' ? txUnshieldLocal
    : submittedKind === 'unshield-xchain' ? txUnshieldXchain
    : null
  const record = activeTx?.record ?? null

  const computedKind: SubmittedKind = computeKind(tab, destChainId, hubChainId)
  const isXchain = computedKind === 'unshield-xchain'
  // Display fee per (kind, amount, quote):
  //   transfer-shielded → relayer's `transfer` tier from the quote (A4); 0n pre-quote-load
  //   unshield-local    → relayer's `unshield` tier from the quote (A3+); 0n pre-quote-load
  //   unshield-xchain   → relayer's `crossChainUnshield` tier (A5). A separate CCTP fast-fee
  //                       (~2 bps) applies on top — surfaced via `cctpFee` below as the secondary
  //                       FeeSummary line so the user sees both deductions.
  const fee: bigint = userFeeForKind(computedKind, amount, quote)
  // CCTP fast-fee — paid out of the destination mint on xchain, not the user's shielded balance.
  // Distinct semantics from `fee` (which is the on-top relayer fee). Zero for non-xchain kinds.
  const cctpFee: bigint = isXchain ? cctpFastFeeForAmount(amount) : 0n
  // Per-kind fee math (recipient gets / user is debited / how much they can type) lives in one
  // shared helper — see `lib/relayer.ts::computeFeeBreakdown`. The xchain branch uses
  // `secondaryFee` to model the CCTP fee being deducted from the recipient mint, separate from
  // the broadcaster fee on top.
  // useDisplayFees normalizes shape (protocolFee + nativeGas) — 0n for these kinds today, but
  // routes through DepositAmountCard's tooltip via flowBreakdown below.
  const { fees: displayFees, isLoading: feeLoading } = useDisplayFees(
    computedKind,
    amount,
    tab === 'external' && isXchain ? destChainId : hubChainId,
    quote,
  )
  const { recipientReceives, totalDeducted, inputMax } = computeFeeBreakdown(
    computedKind,
    amount,
    fee,
    max,
    { secondaryFee: cctpFee, protocolFee: displayFees.protocolFee },
  )
  const flowBreakdown = {
    broadcasterFee: fee,
    cctpFee: isXchain ? cctpFee : undefined,
    recipientReceives,
    totalDeducted,
    recipientLabel: 'Recipient receives',
  }
  // Inclusive Fee total surfaced on both the input card's FEE row and the review FeeSummary —
  // broadcaster + on-chain protocol + CCTP (when applicable). The breakdown tooltip exposes the
  // individual components.
  const displayedFee = fee + displayFees.protocolFee + cctpFee

  // Reset local state on close.
  useEffect(() => {
    if (!isOpen) {
      setStep('input')
      setSubmitError(null)
      setErrorAtStep(undefined)
      setAmountStr('')
      setRecipient('')
      setTab('private')
      setSubmittedKind(null)
    }
  }, [isOpen])

  // Watch the submitted record for terminal transitions. Dep is `record?.executionState` rather
  // than `record` so artifact patches during xchain polling don't re-fire this needlessly — the
  // body only branches on executionState.
  useEffect(() => {
    if (!record) return
    if (record.executionState === 'completed') setStep('complete')
    else if (record.executionState === 'failed' || record.executionState === 'expired') {
      setStep('error')
      setErrorAtStep('progress')
    }
  }, [record?.executionState])

  function close() {
    setOpenModal(null)
  }

  async function handleSubmit() {
    if (submittingRef.current) return
    submittingRef.current = true
    setIsSubmitting(true)
    setSubmitError(null)
    try {
      // null ⇒ submit refused on a follower tab (useTx.submit toasts + persists nothing); stay on review.
      let submittedId: string | null = null
      // Re-quote if the cached fee is stale — see ShieldModal for the rationale.
      const activeQuote = quote && !isStale ? quote : await refresh()
      if (!activeQuote) {
        throw new Error('Could not fetch a current fee quote — please try again.')
      }
      const feeCacheId = activeQuote.cacheId
      if (computedKind === 'transfer-shielded') {
        // Strict-validate the user's typed 0zk recipient (bech32m checksum, not just shape) at the
        // funds-committing boundary — a transposed character would otherwise send a private
        // transfer to a valid-shaped but wrong/unspendable address. The input step's regex is only
        // a fast pre-filter; this is the authoritative check.
        if (!(await validateShieldedAddressStrict(recipient))) {
          throw new Error(
            'That shielded (0zk) address is not valid — double-check it for typos. Funds sent to a ' +
              'malformed shielded address cannot be recovered.',
          )
        }
        // Same address-shape guard as unshield-local — both paths now embed a broadcaster
        // output, so a malformed published address would doom proof gen the same way.
        if (!isShieldedAddress(activeQuote.broadcasterRailgunAddress)) {
          throw new Error(
            'Relayer published an invalid broadcaster address. Refresh and try again; if the ' +
              'problem persists, the relayer may be misconfigured.',
          )
        }
        setSubmittedKind('transfer-shielded')
        submittedId = await txTransfer.submit({
          amount,
          feeCacheId,
          recipient,
          broadcasterFeeAmount: BigInt(activeQuote.fees.transfer),
          broadcasterRailgunAddress: activeQuote.broadcasterRailgunAddress,
          useWalletOverride: prefs.submitFromWallet,
        })
      } else if (computedKind === 'unshield-local') {
        // Fail fast if the relayer published a malformed broadcaster address — see UnshieldModal's
        // version of this check for the rationale (avoid a 20-30s proof gen that's doomed to
        // surface an opaque SDK throw deep in the pipeline).
        if (!isShieldedAddress(activeQuote.broadcasterRailgunAddress)) {
          throw new Error(
            'Relayer published an invalid broadcaster address. Refresh and try again; if the ' +
              'problem persists, the relayer may be misconfigured.',
          )
        }
        setSubmittedKind('unshield-local')
        // Freeze the broadcaster context with the rest of the submit state — same rationale as
        // UnshieldModal: the proof must embed these EXACT values to pass the relayer's verifier.
        submittedId = await txUnshieldLocal.submit({
          amount,
          feeCacheId,
          recipient,
          broadcasterFeeAmount: BigInt(activeQuote.fees.unshield),
          broadcasterRailgunAddress: activeQuote.broadcasterRailgunAddress,
          useWalletOverride: prefs.submitFromWallet,
        })
      } else {
        // A5 — relayer-mediated hub burn for cross-chain unshield. Same broadcaster-context shape
        // as unshield-local + transfer-shielded, with the fee sourced from the `crossChainUnshield`
        // tier of the quote. Fail fast on a malformed broadcaster address so 20-30s of proof gen
        // doesn't end in an opaque SDK throw downstream.
        if (!isShieldedAddress(activeQuote.broadcasterRailgunAddress)) {
          throw new Error(
            'Relayer published an invalid broadcaster address. Refresh and try again; if the ' +
              'problem persists, the relayer may be misconfigured.',
          )
        }
        setSubmittedKind('unshield-xchain')
        submittedId = await txUnshieldXchain.submit({
          amount,
          feeCacheId,
          toChainId: destChainId,
          recipient,
          broadcasterFeeAmount: BigInt(activeQuote.fees.crossChainUnshield),
          broadcasterRailgunAddress: activeQuote.broadcasterRailgunAddress,
          useWalletOverride: prefs.submitFromWallet,
        })
      }
      if (submittedId === null) return
      setStep('progress')
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Submit failed.')
      setStep('error')
      setErrorAtStep('review')
    } finally {
      submittingRef.current = false
      setIsSubmitting(false)
    }
  }

  if (!isOpen) return null

  return (
    <DepositOverlayShell
      open
      onClose={close}
      dismissible={step !== 'progress'}
      flowLabel="Send"
      currentStep={overlayIndicatorStep(step)}
      status={overlayIndicatorStatus(step)}
    >
      <RelayerStatusBanner isOpen={isOpen} />
      {step === 'input' && (
        <>
          <SendInputStepContent
            tab={tab}
            onTabChange={t => {
              setTab(t)
              setRecipient('') // recipient format differs between tabs; clear on switch
            }}
            destChainId={destChainId}
            onDestChainIdChange={setDestChainId}
            recipient={recipient}
            onRecipientChange={setRecipient}
            amountStr={amountStr}
            onAmountChange={setAmountStr}
            max={max}
            maxInput={inputMax}
            displayFees={displayFees}
            flowBreakdown={flowBreakdown}
            feeLoading={feeLoading}
            // The user always signs on HUB regardless of tab — `transfer-shielded` runs the
            // proof-bearing tx on hub, `unshield-local` likewise, and `unshield-xchain` signs
            // `atomicCrossChainUnshield` on hub before CCTP delivers on the destination chain.
            // Previously `tab === 'external' && isXchain ? destChainId : hubChainId` wrongly
            // warned about ETH on the destination chain — no destination-chain tx is ever sent
            // from the user's wallet.
            gasChainId={hubChainId}
            // SendModal's three kinds default to the relayer path; user pays gas only when
            // they've toggled Preferences → "Submit transactions from my wallet".
            gaslessMode={!prefs.submitFromWallet}
            destDeploymentError={destDeploymentError}
          />
          <SendInputStepFooter
            tab={tab}
            recipient={recipient}
            amountStr={amountStr}
            maxInput={inputMax}
            destDeploymentError={destDeploymentError}
            onCancel={close}
            onContinue={() => setStep('review')}
          />
        </>
      )}
      {step === 'review' && (
        <SendReviewStep
          tab={tab}
          destChainId={destChainId}
          recipient={recipient}
          amount={amount}
          fee={displayedFee}
          totalDeducted={totalDeducted}
          isXchain={isXchain}
          submitBlockedReason={syncGate.reason}
          onBack={() => setStep('input')}
          isSubmitting={isSubmitting}
          onConfirm={handleSubmit}
        />
      )}
      {step === 'progress' && <ProgressStep record={record} />}
      {step === 'complete' && (
        <SendCompleteStep
          tab={tab}
          destChainId={destChainId}
          recipient={recipient}
          recipientReceives={recipientReceives}
          totalDeducted={totalDeducted}
          // Hub-chain explorer link for the on-chain submission. The destination delivery for
          // xchain is a separate event tracked elsewhere; this is the source-chain action.
          explorerUrl={txExplorerUrl(record?.walletContext.sourceChainId, displayTxHash(record))}
          onDone={close}
        />
      )}
      {step === 'error' && (
        <ErrorStep
          error={record?.artifacts.error ?? null}
          message={submitError ?? undefined}
          explorerUrl={txExplorerUrl(record?.walletContext.sourceChainId, displayTxHash(record))}
          onRetry={
            errorAtStep === 'review'
              ? () => {
                  setSubmitError(null)
                  setErrorAtStep(undefined)
                  setStep('review')
                }
              : () => {
                  // Only advance to the progress step if the executor ACCEPTS the retry (marks the
                  // record `retrying` + re-dispatches). A refused retry (not retryable) must leave
                  // the user on the error step with the honest error + explorer link, not flip to a
                  // stuck spinner — that was the P0-4 no-op bug.
                  setErrorAtStep(undefined)
                  void activeTx?.retry()?.then((accepted) => {
                    if (accepted) setStep('progress')
                  })
                }
          }
        />
      )}
    </DepositOverlayShell>
  )
}
