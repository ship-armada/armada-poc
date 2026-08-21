// ABOUTME: useUnshieldFlow — the unshield (private → your own EVM wallet) flow controller.
// ABOUTME: Recipient is pinned to the connected wallet; a to-chain picker drives unshield-local (hub) vs unshield-xchain (client). No ethers/execution here — that lives in features/unshield*.

import { useEffect, useRef, useState } from 'react'
import { useAtomValue } from 'jotai'
import { useAccount } from 'wagmi'
import { evmAddressAtom, shieldedUsdcAtom, shieldedUsdcSpendableAtom, shieldedWalletAtom } from '@/state/wallet'
import { preferencesAtom } from '@/state/preferences'
import { useTx } from '@/hooks/useTx'
import { useFees } from '@/hooks/useFees'
import { useDisplayFees } from '@/hooks/useDisplayFees'
import { useSpendableSyncGate } from '@/hooks/useSpendableSyncGate'
import { cctpFastFeeForAmount, computeFeeBreakdown, userFeeForKind } from '@/lib/relayer'
import { getChainById, getNetworkConfig } from '@/config/network'
import { findDeploymentForChain, loadDeployments, type ResolvedDeployments } from '@/config/deployments'
import { parseUsdcInput } from '@/lib/format'
import { isShieldedAddress } from '@/lib/address'
import { canRetryTx } from '@/lib/tx/executor'
import { resolveFreshQuote } from '@/lib/tx/submitQuote'
import { trackError } from '@/lib/telemetry'
import { assertSpendableForFeeOnTop } from '@/lib/tx/spendable'
import type { FlowStep, FlowVisibleStep } from '@/components/flow'
import type { DisplayFees } from '@/lib/fees/displayFees'
import type { FlowFeeBreakdown } from '@/components/ui/FeeBreakdownTooltip'
import type { TxRecord } from '@/lib/tx/types'

type SubmittedKind = 'unshield-local' | 'unshield-xchain'

/** Unshield to your own wallet: local when the destination is the hub, cross-chain otherwise. */
function computeKind(toChainId: number, hubChainId: number): SubmittedKind {
  return toChainId === hubChainId ? 'unshield-local' : 'unshield-xchain'
}

export interface UnshieldFlow {
  // Form
  toChainId: number
  setToChainId: (chainId: number) => void
  amountStr: string
  setAmountStr: (next: string) => void
  amount: bigint
  max: bigint
  pendingUsdc: bigint
  // Fee / display
  displayFees: DisplayFees
  feeLoading: boolean
  flowBreakdown: FlowFeeBreakdown
  /** Inclusive fee (broadcaster + on-chain protocol + CCTP) shown on the review/complete cards. */
  feeInclusive: bigint
  /** True when a submit-time fee refetch changed the fee — the review step shows the FeeUpdatedBanner. */
  feeChanged: boolean
  totalDeducted: bigint
  inputMax: bigint
  isXchain: boolean
  // Review / summary
  recipient: string
  shieldedAddress?: string
  recipientWalletProvider?: string
  networkName?: string
  destDeploymentError?: string
  submitBlockedReason?: string
  // Flow state
  step: FlowStep
  isSubmitting: boolean
  record: TxRecord | null
  submitError: string | null
  // Actions
  onContinueToReview: () => void
  onBackToInput: () => void
  submit: () => Promise<void>
  errorPrimaryLabel: string
  onErrorPrimary: () => void
}

export function useUnshieldFlow(isOpen: boolean): UnshieldFlow {
  const prefs = useAtomValue(preferencesAtom)
  const shieldedWallet = useAtomValue(shieldedWalletAtom)

  // Destination = the connected EVM wallet (pinned; this is "unshield to my own wallet").
  const connectedEvm = useAtomValue(evmAddressAtom)
  const { connector } = useAccount()
  const recipient = connectedEvm ?? ''

  // Form state.
  const hubChainId = getNetworkConfig().hub.chainId
  const [toChainId, setToChainId] = useState<number>(hubChainId)
  const [amountStr, setAmountStr] = useState<string>('')

  // Flow state.
  const [step, setStep] = useState<FlowStep>('input')
  const [errorAtStep, setErrorAtStep] = useState<FlowVisibleStep | undefined>(undefined)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [submittedKind, setSubmittedKind] = useState<SubmittedKind | null>(null)
  // Set when a submit-time fee refetch changed the fee — keeps the flow on Review with the banner.
  const [feeChanged, setFeeChanged] = useState(false)
  const submittingRef = useRef(false)
  const [isSubmitting, setIsSubmitting] = useState(false)

  // Source: `max` (+ the fee-on-top guard) draws from SPENDABLE only, so a not-yet-final ("pending")
  // note can't be selected; `pendingUsdc` is display-only (0 on local Anvil).
  const shieldedUsdc = useAtomValue(shieldedUsdcAtom)
  const shieldedUsdcSpendable = useAtomValue(shieldedUsdcSpendableAtom)
  const max = shieldedUsdcSpendable ?? 0n
  const pendingUsdc = (shieldedUsdc ?? 0n) - max
  const { value: amount } = parseUsdcInput(amountStr)
  // The reviewed fee is recomputed on every amount change, so clear any prior fee-changed flag.
  useEffect(() => { setFeeChanged(false) }, [amountStr])
  const { quote, refresh } = useFees()
  // Gate Confirm while the initial shielded-balance sync is incomplete — every unshield spends
  // the user's shielded USDC.
  const syncGate = useSpendableSyncGate()

  // Deployment manifests — validate that the chosen destination chain actually has a deployment
  // present, otherwise the user could pick a chain the submit step would throw on.
  const [deployments, setDeployments] = useState<ResolvedDeployments | null>(null)
  useEffect(() => {
    if (!isOpen) return
    let cancelled = false
    void loadDeployments()
      .then((d) => {
        if (!cancelled) setDeployments(d)
      })
      .catch((err) => {
        // Leave `deployments` null — `destHasDeployment` stays `true` until the manifest is known,
        // so the user can still proceed; the submit step's own error path surfaces a persistent
        // failure. Telemetry is the only signal we have here.
        trackError('useUnshieldFlow.loadDeployments', err, {
          scope: 'unshield.deployments',
          message: 'failed to load deployment manifests for destination-chain check',
        })
      })
    return () => {
      cancelled = true
    }
  }, [isOpen])

  const computedKind: SubmittedKind = computeKind(toChainId, hubChainId)
  const isXchain = computedKind === 'unshield-xchain'

  const destHasDeployment = !deployments
    ? true
    : findDeploymentForChain(deployments, toChainId) !== undefined
  const destDeploymentError = destHasDeployment
    ? undefined
    : 'This destination chain has no deployment manifest. Pick another chain.'

  const txUnshieldLocal = useTx({ kind: 'unshield-local' })
  const txUnshieldXchain = useTx({ kind: 'unshield-xchain' })
  const activeTx =
    submittedKind === 'unshield-local'
      ? txUnshieldLocal
      : submittedKind === 'unshield-xchain'
        ? txUnshieldXchain
        : null
  const record = activeTx?.record ?? null

  // Display fee per (kind, amount, quote): unshield-local → relayer's `unshield` tier;
  // unshield-xchain → `crossChainUnshield` tier + a CCTP fast-fee (~2 bps) on the destination mint.
  const fee: bigint = userFeeForKind(computedKind, amount, quote)
  const cctpFee: bigint = isXchain ? cctpFastFeeForAmount(amount) : 0n
  const { fees: displayFees, isLoading: feeLoading } = useDisplayFees(
    computedKind,
    amount,
    isXchain ? toChainId : hubChainId,
    quote,
  )
  const { recipientReceives, totalDeducted, inputMax } = computeFeeBreakdown(
    computedKind,
    amount,
    fee,
    max,
    { secondaryFee: cctpFee, protocolFee: displayFees.protocolFee },
  )
  const flowBreakdown: FlowFeeBreakdown = {
    broadcasterFee: fee,
    cctpFee: isXchain ? cctpFee : undefined,
    recipientReceives,
    totalDeducted,
    recipientLabel: "You'll receive",
  }
  const feeInclusive = fee + displayFees.protocolFee + cctpFee

  // Reset local state on close so re-opening starts fresh.
  useEffect(() => {
    if (!isOpen) {
      setStep('input')
      setSubmitError(null)
      setErrorAtStep(undefined)
      setAmountStr('')
      setToChainId(hubChainId)
      setSubmittedKind(null)
    }
  }, [isOpen])

  // Terminal-state → step transition. Dep is `record?.executionState` so artifact patches during
  // xchain polling don't re-fire needlessly.
  useEffect(() => {
    if (!record) return
    if (record.executionState === 'completed') setStep('complete')
    else if (record.executionState === 'failed' || record.executionState === 'expired') {
      setStep('error')
      setErrorAtStep('progress')
    }
  }, [record?.executionState])

  async function submit() {
    if (submittingRef.current) return
    submittingRef.current = true
    setIsSubmitting(true)
    setSubmitError(null)
    try {
      let submittedId: string | null = null
      // Always refetch a fresh cacheId before proof gen (a stale cacheId is the FEE_EXPIRED cause);
      // if the fee moved since Review, bounce back with the banner rather than silently swapping it.
      const { quote: activeQuote, feeChanged: changed } = await resolveFreshQuote({
        refresh,
        reviewedFee: fee,
        feeOf: (s) => userFeeForKind(computedKind, amount, s),
      })
      if (!activeQuote) {
        throw new Error('Could not fetch a current fee quote — please try again.')
      }
      if (changed) {
        setFeeChanged(true)
        setStep('review')
        return
      }
      const feeCacheId = activeQuote.cacheId
      // S-M5: re-validate amount + the FRESH relayer fee against the balance before proof gen. Both
      // kinds draw the fee from the shielded balance (fee-on-top) on the relayer path; wallet-
      // override pays native gas separately, so no shielded fee applies there.
      const freshFee =
        computedKind === 'unshield-local'
          ? BigInt(activeQuote.fees.unshield)
          : BigInt(activeQuote.fees.crossChainUnshield)
      assertSpendableForFeeOnTop({ amount, fee: prefs.submitFromWallet ? 0n : freshFee, balance: max })
      // Fail fast if the relayer published a malformed broadcaster address — avoid a 20-30s proof
      // gen doomed to surface an opaque SDK throw deep in the pipeline.
      if (!isShieldedAddress(activeQuote.broadcasterShieldedAddress)) {
        throw new Error(
          'Relayer published an invalid broadcaster address. Refresh and try again; if the ' +
            'problem persists, the relayer may be misconfigured.',
        )
      }
      if (computedKind === 'unshield-local') {
        setSubmittedKind('unshield-local')
        submittedId = await txUnshieldLocal.submit({
          amount,
          feeCacheId,
          recipient,
          broadcasterFeeAmount: BigInt(activeQuote.fees.unshield),
          broadcasterShieldedAddress: activeQuote.broadcasterShieldedAddress,
          useWalletOverride: prefs.submitFromWallet,
        })
      } else {
        setSubmittedKind('unshield-xchain')
        submittedId = await txUnshieldXchain.submit({
          amount,
          feeCacheId,
          toChainId,
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

  const errorRetryable = errorAtStep === 'review' || (record != null && canRetryTx(record))
  const errorPrimaryLabel = errorRetryable ? 'Try again' : 'Start over'
  function onErrorPrimary() {
    if (errorAtStep === 'review') {
      setSubmitError(null)
      setErrorAtStep(undefined)
      setStep('review')
      return
    }
    if (record != null && canRetryTx(record)) {
      setErrorAtStep(undefined)
      void activeTx?.retry()?.then((accepted) => {
        if (accepted) setStep('progress')
      })
      return
    }
    setSubmitError(null)
    setErrorAtStep(undefined)
    setStep('input')
  }

  return {
    toChainId,
    setToChainId,
    amountStr,
    setAmountStr,
    amount,
    max,
    pendingUsdc,
    displayFees,
    feeLoading,
    flowBreakdown,
    feeInclusive,
    feeChanged,
    totalDeducted,
    inputMax,
    isXchain,
    recipient,
    shieldedAddress: shieldedWallet.shieldedAddress,
    recipientWalletProvider: connector?.name,
    networkName: getChainById(toChainId)?.name,
    destDeploymentError,
    submitBlockedReason: syncGate.reason ?? undefined,
    step,
    isSubmitting,
    record,
    submitError,
    onContinueToReview: () => setStep('review'),
    onBackToInput: () => setStep('input'),
    submit,
    errorPrimaryLabel,
    onErrorPrimary,
  }
}
