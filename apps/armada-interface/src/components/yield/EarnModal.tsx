// ABOUTME: EarnModal — vault deposit + withdrawal. Add Funds tab uses yield-deposit; Withdraw tab uses yield-withdraw.
// ABOUTME: Matches either openModalAtom === 'yield-deposit' or === 'yield-withdraw'; the entry point picks the initial tab.

import { useEffect, useState } from 'react'
import { useAtom, useAtomValue } from 'jotai'
import { openModalAtom, type ModalKind } from '@/state/ui'
import { preferencesAtom } from '@/state/preferences'
import { RelayerStatusBanner } from '@/components/RelayerStatusBanner'
import { shieldedUsdcAtom, yieldSharesAtom } from '@/state/wallet'
import { useTx } from '@/hooks/useTx'
import { useFees } from '@/hooks/useFees'
import { useSpendableSyncGate } from '@/hooks/useSpendableSyncGate'
import { useYieldRate } from '@/hooks/useYieldRate'
import { formatUsdcAmount, parseUsdcInput } from '@/lib/format'
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
  // A6 — frozen into the record meta at submit-time so a mid-flight toggle doesn't strand the handler.
  const prefs = useAtomValue(preferencesAtom)

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
  // TEMP — yield-withdraw is forced to user-wallet submission because the broadcaster-fee
  // mechanism doesn't fit the current `ArmadaYieldAdapter.redeemAndShield` shape. The SDK
  // generates one Transaction per token (shares unshield to adapter + USDC unshield to
  // broadcaster), but the adapter only consumes a single Transaction whose unshieldPreimage
  // MUST be shares. Tracked at ship-armada/armada-poc#312 (multi-Transaction adapter).
  // yield-deposit is unaffected — input and broadcaster fee are both USDC, so the SDK fits
  // them in a single Transaction.
  const forceWalletForWithdraw = tab === 'withdraw'
  const effectiveUseWalletOverride = prefs.submitFromWallet || forceWalletForWithdraw
  // When the user-wallet path is in effect, no broadcaster fee is baked into the proof — the
  // user pays gas in ETH instead.
  const fee: bigint = effectiveUseWalletOverride ? 0n : userFeeForKind(yieldKind, amount, quote)
  // Both yield ops are fee-on-top in `computeFeeBreakdown`'s model, but the balance flows differ:
  //   - Add Funds: user unshields (amount + fee) USDC. `totalDeducted = amount + fee` is the
  //     literal private-balance debit. `recipientReceives = amount` is what the vault gains.
  //   - Withdraw: vault redeems `amount` USDC, ALL of it shields back to user. The broadcaster
  //     fee comes from a SEPARATE unshield of user's pre-existing private USDC (see
  //     adapter.redeemAndShield + SDK CrossContractCalls broadcaster handling). Net private
  //     balance change is +(amount - fee); vault balance drops by `amount`-worth of shares.
  const { recipientReceives, totalDeducted, inputMax: feeOnTopInputMax } = computeFeeBreakdown(
    yieldKind,
    amount,
    fee,
    max,
  )
  // For withdraw the fee doesn't come from the vault — it's debited from private USDC via a
  // separate unshield in the same proof. Reserving `fee` against the vault `max` would collapse
  // the typeable cap to 0 whenever `fee >= vault balance` (e.g. a $0.50 fee on a $0.40 vault
  // balance), even though the user can perfectly well withdraw the full $0.40 as long as their
  // private balance covers the fee. The private-USDC sufficiency check is enforced via the
  // pre-flight `continueBlockedReason` below; here we just expose the full vault balance as
  // typeable.
  const inputMax: bigint = tab === 'add' ? feeOnTopInputMax : max
  // Per-tab display values handed down to the step components. The step components stay dumb;
  // EarnModal owns the per-tab semantic translation.
  //
  // For withdraw, the redeem proceeds (`amount`) are shielded back to the user IN FULL — that's
  // the vault→private flow. The broadcaster fee is a SEPARATE leg (private→relayer) shown on
  // its own row. Combining them into a single net line would frame two independent flows as
  // one, surfacing "0 received" whenever fee >= amount even though the user did get `amount`
  // back from the vault. Better to show both lines as-is and let the user compose mentally.
  const displayNetAmount: bigint = tab === 'add' ? totalDeducted : amount
  const displayNetLabel: string =
    tab === 'add' ? 'Total deducted from balance' : "You'll receive into private balance"
  // Pre-flight: the withdraw broadcaster fee is unshielded from the user's PRE-EXISTING private
  // USDC (the proof needs a USDC UTXO; the redeem proceeds aren't available at proof-construction
  // time). If the user's private USDC is below the fee, proof gen will fail 20-30s in. Block at
  // submit-time with a clear reason instead. Only enforced when we have a real fee quote — pre-quote
  // we don't know the number yet.
  const withdrawFeeShortfall = tab === 'withdraw' && fee > 0n && (shieldedUsdc ?? 0n) < fee
  const withdrawFeeBlockedReason: string | null = withdrawFeeShortfall
    ? `You need at least ${formatUsdcAmount(fee)} USDC in your private balance to cover the withdrawal fee. Add USDC from another source before withdrawing.`
    : null
  // Composed gate for the review step — sync gate OR private-USDC shortfall.
  const submitBlockedReason: string | null = syncGate.reason || withdrawFeeBlockedReason

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
          useWalletOverride: effectiveUseWalletOverride,
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
          useWalletOverride: effectiveUseWalletOverride,
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
      <RelayerStatusBanner isOpen={isOpen} />
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
          netAmount={displayNetAmount}
          netLabel={displayNetLabel}
          continueBlockedReason={withdrawFeeBlockedReason}
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
          netAmount={displayNetAmount}
          netLabel={displayNetLabel}
          submitBlockedReason={submitBlockedReason}
          onBack={() => setStep('input')}
          onConfirm={handleSubmit}
        />
      )}
      {step === 'progress' && <ProgressStep record={record} />}
      {step === 'complete' && (
        <EarnCompleteStep
          tab={tab}
          // Add: vault gained `recipientReceives` (= amount) of USDC; user spent amount + fee.
          // Withdraw: vault returned `amount` USDC into the user's private balance; the
          // broadcaster fee was paid as a separate proof leg out of the user's existing private
          // USDC. The success copy reads "Returned amount USDC" because that's literally what
          // came back from the vault — the fee debit is accounted for separately.
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
