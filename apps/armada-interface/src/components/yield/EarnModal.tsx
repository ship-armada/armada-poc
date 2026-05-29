// ABOUTME: EarnModal — vault deposit + withdrawal. Add Funds tab uses yield-deposit; Withdraw tab uses yield-withdraw.
// ABOUTME: Matches either openModalAtom === 'yield-deposit' or === 'yield-withdraw'; the entry point picks the initial tab.

import { useEffect, useState } from 'react'
import { useAtom, useAtomValue } from 'jotai'
import { openModalAtom, type ModalKind } from '@/state/ui'
import { shieldedUsdcAtom, yieldSharesAtom } from '@/state/wallet'
import { useTx } from '@/hooks/useTx'
import { useFees } from '@/hooks/useFees'
import { useSpendableSyncGate } from '@/hooks/useSpendableSyncGate'
import { useYieldRate } from '@/hooks/useYieldRate'
import { parseUsdcInput } from '@/lib/format'
import { computeFeeBreakdown, userFeeForKind } from '@/lib/relayer'
import { isShieldedAddress } from '@/lib/address'
import { displayTxHash, txExplorerUrl } from '@/lib/explorer'
import { sharesToUsdc } from '@/lib/yield'
import {
  ActionFlowShell,
  ProgressStep,
  ErrorStep,
  type FlowStep,
  type FlowVisibleStep,
} from '@/components/flow'
import { EarnInputStep, type EarnTab } from './EarnInputStep'
import { EarnReviewStep } from './EarnReviewStep'
import { EarnCompleteStep } from './EarnCompleteStep'

type LocalStep = FlowStep
const STEPS: ReadonlyArray<FlowVisibleStep> = ['input', 'review', 'progress', 'complete']

const EARN_KINDS: ReadonlyArray<ModalKind> = ['yield-deposit', 'yield-withdraw']

export function EarnModal() {
  const [openModal, setOpenModal] = useAtom(openModalAtom)
  const isOpen = EARN_KINDS.includes(openModal)
  const initialTab: EarnTab = openModal === 'yield-withdraw' ? 'withdraw' : 'add'

  // Form state
  const [tab, setTab] = useState<EarnTab>(initialTab)
  const [amountStr, setAmountStr] = useState<string>('')

  // Flow state
  const [step, setStep] = useState<LocalStep>('input')
  const [errorAtStep, setErrorAtStep] = useState<FlowVisibleStep | undefined>(undefined)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [submittedKind, setSubmittedKind] = useState<'yield-deposit' | 'yield-withdraw' | null>(null)

  // Source data
  const shieldedUsdc = useAtomValue(shieldedUsdcAtom)
  const yieldShares = useAtomValue(yieldSharesAtom)
  const { rate: yieldRate, refresh: refreshYieldRate } = useYieldRate()
  // Earning balance (USDC) requires both shares + rate to compute.
  const earningUsdc =
    yieldShares !== null && yieldRate !== null ? sharesToUsdc(yieldShares, yieldRate.rate) : null
  const max = tab === 'add' ? shieldedUsdc ?? 0n : earningUsdc ?? 0n

  const { value: amount } = parseUsdcInput(amountStr)
  const { quote, isStale, refresh } = useFees()
  // Yield ops spend the user's shielded USDC (deposit) or shielded yield shares (withdraw).
  // Either way, we need a successful first sync before letting the user submit.
  const syncGate = useSpendableSyncGate()
  // A4 — yield ops are relayer-mediated. Fee comes from the quote's crossContract tier.
  const yieldKind: 'yield-deposit' | 'yield-withdraw' = tab === 'add' ? 'yield-deposit' : 'yield-withdraw'
  const fee: bigint = userFeeForKind(yieldKind, amount, quote)
  // Both yield ops are fee-on-top: the broadcaster output sits alongside the vault spend in
  // the same proof; user's shielded USDC pays the fee on top of the deposit/withdraw amount.
  const { recipientReceives, totalDeducted, inputMax } = computeFeeBreakdown(
    yieldKind,
    amount,
    fee,
    max,
  )

  // Two useTx hooks; only one gets a record per flow.
  const txDeposit = useTx({ kind: 'yield-deposit' })
  const txWithdraw = useTx({ kind: 'yield-withdraw' })
  const activeTx =
    submittedKind === 'yield-deposit' ? txDeposit
    : submittedKind === 'yield-withdraw' ? txWithdraw
    : null
  const record = activeTx?.record ?? null

  // Reset on close + sync initial tab when the entry-point modal kind changes.
  // Also pull a fresh rate on open so the APY hint + max-balance reflect current state — the
  // background poll only ticks every 5 min and a user opening the modal expects "now" data.
  useEffect(() => {
    if (!isOpen) {
      setStep('input')
      setSubmitError(null)
      setErrorAtStep(undefined)
      setAmountStr('')
      setSubmittedKind(null)
      return
    }
    setTab(initialTab)
    void refreshYieldRate()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen])

  // Watch the submitted record for terminal transitions. On completed, refresh the rate so the
  // post-tx balance / APY view reflects the new vault state immediately (rather than waiting up
  // to 5 min for the next poll tick). Dep is `record?.executionState` rather than `record` so
  // artifact patches during proof-progress updates don't re-fire — the body only branches on
  // executionState. The `refreshYieldRate` reference is intentionally elided from deps (same as
  // the open-side effect above) since its identity can churn without semantic change.
  useEffect(() => {
    if (!record) return
    if (record.executionState === 'completed') {
      setStep('complete')
      void refreshYieldRate()
    }
    else if (record.executionState === 'failed' || record.executionState === 'expired') {
      setStep('error')
      setErrorAtStep('progress')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record?.executionState])

  function close() {
    setOpenModal(null)
  }

  async function handleSubmit() {
    setSubmitError(null)
    try {
      const activeQuote = quote && !isStale ? quote : await refresh()
      if (!activeQuote) {
        throw new Error('Could not fetch a current fee quote — please try again.')
      }
      const feeCacheId = activeQuote.cacheId
      // Same broadcaster address guard as Send / Unshield — fail fast if the relayer published
      // a malformed value rather than paying 20-30s of proof gen for a doomed submission.
      if (!isShieldedAddress(activeQuote.broadcasterRailgunAddress)) {
        throw new Error(
          'Relayer published an invalid broadcaster address. Refresh and try again; if the ' +
            'problem persists, the relayer may be misconfigured.',
        )
      }
      const broadcasterFeeAmount = BigInt(activeQuote.fees.crossContract)
      const broadcasterRailgunAddress = activeQuote.broadcasterRailgunAddress
      if (tab === 'add') {
        setSubmittedKind('yield-deposit')
        await txDeposit.submit({
          amount,
          feeCacheId,
          broadcasterFeeAmount,
          broadcasterRailgunAddress,
        })
      } else {
        setSubmittedKind('yield-withdraw')
        // Slippage protection: re-read the vault rate just before computing shares so the
        // submitted shares reflect the freshest possible exchange ratio. The residual window
        // (this submit-block → execution-block) is ~1 block — at any realistic APY that's well
        // below USDC's display precision.
        const freshRate = await refreshYieldRate()
        const effectiveRate = freshRate ?? yieldRate
        const shares =
          effectiveRate !== null && effectiveRate.rate > 0n
            ? (amount * 1_000_000_000_000_000_000n) / effectiveRate.rate
            : 0n
        await txWithdraw.submit({
          amount,
          feeCacheId,
          shares,
          broadcasterFeeAmount,
          broadcasterRailgunAddress,
        })
      }
      setStep('progress')
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Submit failed.')
      setStep('error')
      setErrorAtStep('review')
    }
  }

  if (!isOpen) return null

  return (
    <ActionFlowShell
      open
      onClose={close}
      title="Earn"
      step={step}
      steps={STEPS}
      errorAtStep={errorAtStep}
    >
      {step === 'input' && (
        <EarnInputStep
          tab={tab}
          onTabChange={t => {
            setTab(t)
            setAmountStr('') // amount caps differ per tab
          }}
          amountStr={amountStr}
          onAmountChange={setAmountStr}
          max={inputMax}
          rate={yieldRate}
          fee={fee}
          totalDeducted={totalDeducted}
          isFeeRefreshing={isStale}
          onCancel={close}
          onContinue={() => setStep('review')}
        />
      )}
      {step === 'review' && (
        <EarnReviewStep
          tab={tab}
          amount={amount}
          rate={yieldRate}
          fee={fee}
          totalDeducted={totalDeducted}
          submitBlockedReason={syncGate.reason}
          onBack={() => setStep('input')}
          onConfirm={handleSubmit}
        />
      )}
      {step === 'progress' && <ProgressStep record={record} />}
      {step === 'complete' && (
        <EarnCompleteStep
          tab={tab}
          recipientReceives={recipientReceives}
          totalDeducted={totalDeducted}
          explorerUrl={txExplorerUrl(record?.walletContext.sourceChainId, displayTxHash(record))}
          onDone={close}
        />
      )}
      {step === 'error' && (
        <ErrorStep
          error={record?.artifacts.error ?? null}
          message={submitError ?? undefined}
          explorerUrl={txExplorerUrl(record?.walletContext.sourceChainId, displayTxHash(record))}
          onRetry={errorAtStep === 'review' ? () => setStep('review') : () => activeTx?.retry()}
        />
      )}
    </ActionFlowShell>
  )
}
