// ABOUTME: SendModal — the shared Send/Withdraw flow. Pays USDC privately (0zk → 0zk) or to a public wallet (0x); the recipient address drives which of three kinds runs.
// ABOUTME: One variant-driven modal (send | withdraw). Mounts three useTx hooks (transfer-shielded / unshield-local / unshield-xchain); submitted-kind state locks the subscription for the rest of the flow.

import { useEffect, useRef, useState } from 'react'
import { useAccount } from 'wagmi'
import { useAtom, useAtomValue } from 'jotai'
import { openModalAtom, paymentIntentAtom } from '@/state/ui'
import { clearPendingPayViaLink } from '@/lib/payViaLink'
import { preferencesAtom } from '@/state/preferences'
import {
  evmAddressAtom,
  shieldedUsdcAtom,
  shieldedUsdcSpendableAtom,
  shieldedWalletAtom,
} from '@/state/wallet'
import { useTx } from '@/hooks/useTx'
import { useRecentRecipients } from '@/hooks/useRecentRecipients'
import type { RecentRecipient } from '@/lib/tx/recentRecipients'
import { useFees } from '@/hooks/useFees'
import { useSpendableSyncGate } from '@/hooks/useSpendableSyncGate'
import { getChainById, getNetworkConfig } from '@/config/network'
import {
  findDeploymentForChain,
  loadDeployments,
  type ResolvedDeployments,
} from '@/config/deployments'
import { parseUsdcInput } from '@/lib/format'
import { cctpFastFeeForAmount, computeFeeBreakdown, userFeeForKind } from '@/lib/relayer'
import { isShieldedAddress, validateShieldedAddressStrict } from '@/lib/address'
import { displayTxHash, txExplorerUrl } from '@/lib/explorer'
import { canRetryTx } from '@/lib/tx/executor'
import { trackError } from '@/lib/telemetry'
import { assertSpendableForFeeOnTop } from '@/lib/tx/spendable'
import {
  ProgressStep,
  ErrorStep,
  type FlowStep,
  type FlowVisibleStep,
} from '@/components/flow'
import { FlowShell } from '@/components/flow/FlowShell'
import { useFlowExit } from '@/components/flow/useFlowExit'
import { SendRecipientStep, type SendFlowVariant } from './SendRecipientStep'
import { SendInputStepContent, SendInputStepFooter } from './SendInputStep'
import { useDisplayFees } from '@/hooks/useDisplayFees'
import { SendReviewStep } from './SendReviewStep'
import { SendCompleteStep } from './SendCompleteStep'
import { RelayerStatusBanner } from '@/components/RelayerStatusBanner'

// The recipient step precedes the shared 3-step overlay flow (input/review/progress/complete/error).
type LocalStep = 'recipient' | FlowStep

type SubmittedKind = 'transfer-shielded' | 'unshield-local' | 'unshield-xchain'

// Address-driven kind selection: a valid shielded (0zk) recipient is an in-pool transfer; any other
// (valid EVM 0x) recipient is an unshield, local when it targets the hub and cross-chain otherwise.
function computeKind(recipient: string, destChainId: number, hubChainId: number): SubmittedKind {
  if (isShieldedAddress(recipient.trim())) return 'transfer-shielded'
  return destChainId === hubChainId ? 'unshield-local' : 'unshield-xchain'
}

export function SendModal() {
  const [openModal, setOpenModal] = useAtom(openModalAtom)
  const [paymentIntent, setPaymentIntent] = useAtom(paymentIntentAtom)
  const isOpen = openModal === 'payment'
  // Send-only: "unshield to my own wallet" now lives in the Shield/Unshield tabbed modal
  // (ShieldModal). The `withdraw` variant copy survives on the step components (ActivityReceipt
  // renders unshield receipts with it), but this modal no longer opens in that variant.
  const variant: SendFlowVariant = 'send'
  // A6 — frozen into the record's meta at submit-time so a mid-flight toggle doesn't strand the handler.
  const prefs = useAtomValue(preferencesAtom)

  // The user's own shielded (Armada) address — rendered as the review/complete summary's
  // "From your private account" row. Optional; the row is omitted when locked/absent.
  const shieldedWallet = useAtomValue(shieldedWalletAtom)

  // Form state
  const hubChainId = getNetworkConfig().hub.chainId
  const connectedEvm = useAtomValue(evmAddressAtom)
  // Connected wallet provider name (wagmi connector) — brands the recipient row glyph when the
  // recipient is the user's own wallet (e.g. withdraw-to-self); mirrors the deposit "From your wallet" row.
  const { connector } = useAccount()
  const [destChainId, setDestChainId] = useState<number>(hubChainId)
  const [recipient, setRecipient] = useState<string>('')
  const [amountStr, setAmountStr] = useState<string>('')

  // Flow state
  const [step, setStep] = useState<LocalStep>('recipient')
  const [errorAtStep, setErrorAtStep] = useState<FlowVisibleStep | undefined>(undefined)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [submittedKind, setSubmittedKind] = useState<SubmittedKind | null>(null)

  // Seed the flow synchronously when it opens from a pay-via-link intent, so the modal starts on
  // Review (recipient + amount are both known) rather than flashing the Recipient step. This runs
  // during render (React's "adjust state on an incoming change" pattern) so FlowShell's stepKey is
  // already 'review' on the first paint — no ModalStepSwitch transition. The atom + pending carrier
  // are consumed in an effect below. Amount-less links land on the amount step instead.
  const [wasOpen, setWasOpen] = useState(false)
  if (isOpen !== wasOpen) {
    setWasOpen(isOpen)
    if (isOpen && paymentIntent) {
      setRecipient(paymentIntent.recipient)
      if (paymentIntent.amount) {
        setAmountStr(paymentIntent.amount)
        setStep('review')
      } else {
        setStep('input')
      }
    }
  }
  // Double-submit guard (P0-7): ref = synchronous gate (state is async), state = button disable.
  const submittingRef = useRef(false)
  const [isSubmitting, setIsSubmitting] = useState(false)

  // Source data. `max` (and the fee-on-top guard) draws from SPENDABLE only, so a not-yet-final
  // ("pending") note can't be selected; `pendingUsdc` is display-only (0 on local Anvil).
  const shieldedUsdc = useAtomValue(shieldedUsdcAtom)
  const shieldedUsdcSpendable = useAtomValue(shieldedUsdcSpendableAtom)
  const max = shieldedUsdcSpendable ?? 0n
  const pendingUsdc = (shieldedUsdc ?? 0n) - max
  const { value: amount } = parseUsdcInput(amountStr)
  const { quote, isStale, refresh } = useFees()
  // Gate Confirm while the initial shielded-balance sync is incomplete. Every kind spends the
  // user's shielded USDC, so the same gate applies.
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

  const computedKind: SubmittedKind = computeKind(recipient, destChainId, hubChainId)
  // Private (0zk) recipient → in-pool transfer; otherwise the funds exit to a public wallet.
  const isPrivate = computedKind === 'transfer-shielded'
  const isXchain = computedKind === 'unshield-xchain'

  // A private (0zk) transfer has no destination-chain concept — the deployment check only applies
  // to public unshields to a specific chain.
  const destHasDeployment =
    isPrivate || !deployments
      ? true
      : findDeploymentForChain(deployments, destChainId) !== undefined
  const destDeploymentError = destHasDeployment
    ? undefined
    : 'This destination chain has no deployment manifest. Pick another chain.'

  // Recently-used recipients (from settled history) offered on the recipient step. Selecting one
  // fills the address and restores its destination chain (0zk transfers have none → back to hub).
  const recentAddresses = useRecentRecipients(5)
  function handleSelectRecent(item: RecentRecipient) {
    setRecipient(item.address)
    setDestChainId(item.destChainId ?? hubChainId)
  }

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
    isXchain ? destChainId : hubChainId,
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
      setStep('recipient')
      setSubmitError(null)
      setErrorAtStep(undefined)
      setAmountStr('')
      setRecipient('')
      setDestChainId(hubChainId)
      setSubmittedKind(null)
    }
  }, [isOpen])

  // Consume the pay-via-link intent once the modal has opened + seeded (the render-time block
  // above applies recipient/amount/step). Clearing the atom + pending carrier here (post-commit)
  // keeps the cross-component write out of render.
  useEffect(() => {
    if (isOpen && paymentIntent) {
      setPaymentIntent(null)
      clearPendingPayViaLink()
    }
  }, [isOpen, paymentIntent, setPaymentIntent])

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

  // Route the close through useFlowExit so FlowShell plays its slide-down before unmounting. The
  // atom stays set (isOpen true) until the animation completes, which keeps the step content frozen.
  const { exiting, requestClose: close } = useFlowExit(() => setOpenModal(null))

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
      // S-M5: re-validate amount + the FRESH relayer fee against the balance before proof gen. All
      // three kinds draw the fee from the shielded balance (fee-on-top) on the relayer path;
      // wallet-override pays native gas separately, so no shielded fee applies there.
      const freshFee = computedKind === 'transfer-shielded'
        ? BigInt(activeQuote.fees.transfer)
        : computedKind === 'unshield-local'
          ? BigInt(activeQuote.fees.unshield)
          : BigInt(activeQuote.fees.crossChainUnshield)
      assertSpendableForFeeOnTop({ amount, fee: prefs.submitFromWallet ? 0n : freshFee, balance: max })
      if (computedKind === 'transfer-shielded') {
        // Strict-validate the user's typed 0zk recipient (bech32m checksum, not just shape) at the
        // funds-committing boundary — a transposed character would otherwise send a private
        // transfer to a valid-shaped but wrong/unspendable address. The recipient step's regex is
        // only a fast pre-filter; this is the authoritative check.
        if (!(await validateShieldedAddressStrict(recipient))) {
          throw new Error(
            'That shielded (0zk) address is not valid — double-check it for typos. Funds sent to a ' +
              'malformed shielded address cannot be recovered.',
          )
        }
        // Same address-shape guard as unshield-local — both paths now embed a broadcaster
        // output, so a malformed published address would doom proof gen the same way.
        if (!isShieldedAddress(activeQuote.broadcasterShieldedAddress)) {
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
          broadcasterShieldedAddress: activeQuote.broadcasterShieldedAddress,
          useWalletOverride: prefs.submitFromWallet,
        })
      } else if (computedKind === 'unshield-local') {
        // Fail fast if the relayer published a malformed broadcaster address — avoid a 20-30s
        // proof gen that's doomed to surface an opaque SDK throw deep in the pipeline.
        if (!isShieldedAddress(activeQuote.broadcasterShieldedAddress)) {
          throw new Error(
            'Relayer published an invalid broadcaster address. Refresh and try again; if the ' +
              'problem persists, the relayer may be misconfigured.',
          )
        }
        setSubmittedKind('unshield-local')
        // Freeze the broadcaster context with the rest of the submit state — the proof must embed
        // these EXACT values to pass the relayer's verifier.
        submittedId = await txUnshieldLocal.submit({
          amount,
          feeCacheId,
          recipient,
          broadcasterFeeAmount: BigInt(activeQuote.fees.unshield),
          broadcasterShieldedAddress: activeQuote.broadcasterShieldedAddress,
          useWalletOverride: prefs.submitFromWallet,
        })
      } else {
        // A5 — relayer-mediated hub burn for cross-chain unshield. Same broadcaster-context shape
        // as unshield-local + transfer-shielded, with the fee sourced from the `crossChainUnshield`
        // tier of the quote. Fail fast on a malformed broadcaster address so 20-30s of proof gen
        // doesn't end in an opaque SDK throw downstream.
        if (!isShieldedAddress(activeQuote.broadcasterShieldedAddress)) {
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
          broadcasterShieldedAddress: activeQuote.broadcasterShieldedAddress,
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

  // FlowShell renders a 4-segment Steps indicator (Recipient / Amount / Review / Confirm).
  // progress / complete / error all map to the final Confirm segment; the ErrorStep itself owns
  // the retry button + copy.
  const currentStep =
    step === 'recipient' ? 1
    : step === 'input' ? 2
    : step === 'review' ? 3
    : 4
  const status: 'default' | 'confirmed' | 'error' =
    step === 'complete' ? 'confirmed'
    : step === 'error' ? 'error'
    : 'default'
  const flowLabel = 'Send'
  // Destination chain name for the summary's Network row — public (0x) recipients only; a private
  // (0zk) transfer has no destination-chain concept.
  const networkName = isPrivate ? undefined : getChainById(destChainId)?.name
  // Brand the public recipient's glyph only when it's the user's own connected wallet — for an
  // arbitrary recipient we don't know their provider, so the summary shows a generic wallet glyph.
  const recipientIsConnectedWallet =
    !isPrivate &&
    connectedEvm != null &&
    recipient.trim().toLowerCase() === connectedEvm.toLowerCase()
  const recipientWalletProvider = recipientIsConnectedWallet ? connector?.name : undefined

  return (
    <FlowShell
      open={isOpen}
      onClose={close}
      exiting={exiting}
      stepKey={step}
      flowLabel={flowLabel}
      steps={['Recipient', 'Amount', 'Review', 'Confirm']}
      currentStep={currentStep}
      status={status}
    >
      <RelayerStatusBanner isOpen={isOpen} />
      {step === 'recipient' && (
        <SendRecipientStep
          variant={variant}
          recipient={recipient}
          onRecipientChange={setRecipient}
          destChainId={destChainId}
          onDestChainIdChange={setDestChainId}
          destDeploymentError={destDeploymentError}
          recentAddresses={recentAddresses}
          onSelectRecent={handleSelectRecent}
          onCancel={close}
          onContinue={() => setStep('input')}
        />
      )}
      {step === 'input' && (
        <>
          <SendInputStepContent
            variant={variant}
            destChainId={destChainId}
            amountStr={amountStr}
            onAmountChange={setAmountStr}
            max={max}
            maxInput={inputMax}
            pending={pendingUsdc}
            displayFees={displayFees}
            flowBreakdown={flowBreakdown}
            feeLoading={feeLoading}
            // The user always signs on HUB regardless of kind — `transfer-shielded` runs the
            // proof-bearing tx on hub, `unshield-local` likewise, and `unshield-xchain` signs
            // `atomicCrossChainUnshield` on hub before CCTP delivers on the destination chain.
            gasChainId={hubChainId}
            // SendModal's three kinds default to the relayer path; user pays gas only when
            // they've toggled Preferences → "Submit transactions from my wallet".
            gaslessMode={!prefs.submitFromWallet}
          />
          <SendInputStepFooter
            amountStr={amountStr}
            maxInput={inputMax}
            onBack={() => setStep('recipient')}
            onContinue={() => setStep('review')}
          />
        </>
      )}
      {step === 'review' && (
        <SendReviewStep
          variant={variant}
          recipient={recipient}
          armadaAddress={shieldedWallet.shieldedAddress}
          amount={amount}
          fee={displayedFee}
          totalDeducted={totalDeducted}
          networkName={networkName}
          recipientWalletProvider={recipientWalletProvider}
          submitBlockedReason={syncGate.reason}
          onBack={() => setStep('input')}
          isSubmitting={isSubmitting}
          onConfirm={handleSubmit}
        />
      )}
      {step === 'progress' && <ProgressStep record={record} sendVariant={variant} />}
      {step === 'complete' && (
        <SendCompleteStep
          variant={variant}
          recipient={recipient}
          armadaAddress={shieldedWallet.shieldedAddress}
          amount={amount}
          fee={displayedFee}
          totalDeducted={totalDeducted}
          networkName={networkName}
          recipientWalletProvider={recipientWalletProvider}
          confirmedAt={record?.updatedAt ?? Date.now()}
          // Hub-chain explorer link for the on-chain submission. The destination delivery for
          // xchain is a separate event tracked elsewhere; this is the source-chain action.
          explorerUrl={txExplorerUrl(record?.walletContext.sourceChainId, displayTxHash(record))}
          onViewExplorer={() => {
            const url = txExplorerUrl(record?.walletContext.sourceChainId, displayTxHash(record))
            if (url) window.open(url, '_blank', 'noopener,noreferrer')
          }}
          onGoToDashboard={close}
        />
      )}
      {step === 'error' && (
        <ErrorStep
          error={record?.artifacts.error ?? null}
          message={submitError ?? undefined}
          explorerUrl={txExplorerUrl(record?.walletContext.sourceChainId, displayTxHash(record))}
          primaryLabel={
            errorAtStep === 'review' || (record != null && canRetryTx(record))
              ? 'Try again'
              : 'Start over'
          }
          onRetry={
            errorAtStep === 'review'
              ? () => {
                  setSubmitError(null)
                  setErrorAtStep(undefined)
                  setStep('review')
                }
              : record != null && canRetryTx(record)
                ? () => {
                    // Only advance to the progress step if the executor ACCEPTS the retry (marks the
                    // record `retrying` + re-dispatches). A refused retry (not retryable) must leave
                    // the user on the error step with the honest error + explorer link, not flip to a
                    // stuck spinner — that was the P0-4 no-op bug.
                    setErrorAtStep(undefined)
                    void activeTx?.retry()?.then((accepted) => {
                      if (accepted) setStep('progress')
                    })
                  }
                : () => {
                    // S-M3: build-proof / FEE_EXPIRED / DUPLICATE_TX failures aren't retryable in
                    // place; return to the input step (form state preserved) so the user can start a
                    // fresh transaction instead of clicking a dead "Try again".
                    setSubmitError(null)
                    setErrorAtStep(undefined)
                    setStep('input')
                  }
          }
        />
      )}
    </FlowShell>
  )
}
