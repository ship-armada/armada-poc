// ABOUTME: ShieldModal — orchestrator for the shield (deposit) action flow. Owns step + form state; renders DepositOverlayShell with InputStep/ReviewStep/ProgressStep/CompleteStep/ErrorStep.
// ABOUTME: Dispatches between same-chain shield (hub source) and cross-chain shield-xchain (client source) based on fromChainId; B3 routes hub shield through GaslessShieldWrapper when available.

import { useEffect, useState } from 'react'
import { useAtom, useAtomValue } from 'jotai'
import { useQuery } from '@tanstack/react-query'
import { openModalAtom } from '@/state/ui'
import { preferencesAtom } from '@/state/preferences'
import { useTx } from '@/hooks/useTx'
import { useFees } from '@/hooks/useFees'
import { useDisplayFees } from '@/hooks/useDisplayFees'
import { useRelayerHealth } from '@/hooks/useRelayerHealth'
import { cctpFastFeeForAmount, computeFeeBreakdown, userFeeForKind } from '@/lib/relayer'
import { useBalances } from '@/hooks/useBalances'
import { getNetworkConfig } from '@/config/network'
import { loadDeployments } from '@/config/deployments'
import { formatUsdc, parseUsdcInput } from '@/lib/format'
import { displayTxHash, txExplorerUrl } from '@/lib/explorer'
import {
  ProgressStep,
  ErrorStep,
  overlayIndicatorStep,
  overlayIndicatorStatus,
  type FlowStep,
  type FlowVisibleStep,
} from '@/components/flow'
import { DepositOverlayShell } from '@/components/deposit/DepositOverlayShell/DepositOverlayShell'
import { RelayerStatusBanner } from '@/components/RelayerStatusBanner'
import { ShieldInputStepContent, ShieldInputStepFooter } from './ShieldInputStep'
import { ShieldReviewStep } from './ShieldReviewStep'
import { ShieldCompleteStep } from './ShieldCompleteStep'

type LocalStep = FlowStep
type SubmittedKind = 'shield' | 'shield-xchain'


/**
 * Permit deadline window. The relayer's fee TTL is 5 min and proof building isn't required for
 * shield, so a 10 min window comfortably covers the build-proof signature + relayer broadcast
 * + on-chain inclusion. Longer windows leave a stranded permit floating in the user's history;
 * shorter windows risk expiring while the user reads the review step.
 */
const PERMIT_DEADLINE_WINDOW_SEC = 10 * 60

function computeKind(fromChainId: number, hubChainId: number): SubmittedKind {
  return fromChainId === hubChainId ? 'shield' : 'shield-xchain'
}

export function ShieldModal() {
  const [openModal, setOpenModal] = useAtom(openModalAtom)
  const isOpen = openModal === 'shield'
  const prefs = useAtomValue(preferencesAtom)

  // Form state.
  const hubChainId = getNetworkConfig().hub.chainId
  const [fromChainId, setFromChainId] = useState<number>(hubChainId)
  const [amountStr, setAmountStr] = useState<string>('')

  // Flow state.
  const [step, setStep] = useState<LocalStep>('input')
  const [errorAtStep, setErrorAtStep] = useState<FlowVisibleStep | undefined>(undefined)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [submittedKind, setSubmittedKind] = useState<SubmittedKind | null>(null)

  const balances = useBalances()
  const max = balances.unshielded[fromChainId] ?? 0n
  const { value: amount } = parseUsdcInput(amountStr)

  // Cached deployment manifests — used to discover the per-chain wrapper address. Loaded once
  // at startup via the standard React Query pattern; rarely changes at runtime.
  const deployments = useQuery({
    queryKey: ['deployments'],
    queryFn: () => loadDeployments(),
    staleTime: Infinity,
    gcTime: Infinity,
  })

  // Relayer-side health. Only consult to flip the gasless toggle off when the relayer is in a
  // state that can't safely accept submits; the banner itself is rendered at the bottom of the
  // shell for user-visible context, same as the unshield flow. `isDegraded` covers both `stale`/
  // `unhealthy` AND total unreachability — anything outside that is safe to route through.
  const { data: healthData, isDegraded } = useRelayerHealth({ enabled: isOpen })
  // Require a positive health signal (not just absence of degradation) so the still-loading
  // state defaults to direct-submit rather than optimistically advertising a gasless fee that
  // the relayer might immediately reject.
  const relayerAvailable = !isDegraded && healthData !== undefined

  const computedKind: SubmittedKind = computeKind(fromChainId, hubChainId)

  // Phase B3/B4 — gasless path is available when the wrapper for the source chain is deployed,
  // the relayer reports healthy/degraded, and the user hasn't opted into wallet-override.
  //   - `shield` (hub):           reads `deployments.hub.contracts.gaslessShieldWrapper`.
  //   - `shield-xchain` (client): reads the per-client `gaslessShieldWrapperClient`.
  const hubWrapperAddress = deployments.data?.hub.contracts.gaslessShieldWrapper
  const clientWrapperAddress =
    computedKind === 'shield-xchain'
      ? deployments.data?.clients.find(c => c.chainId === fromChainId)?.contracts.gaslessShieldWrapperClient
      : undefined
  const wrapperAddress =
    computedKind === 'shield' ? hubWrapperAddress : clientWrapperAddress
  const useGasless: boolean =
    wrapperAddress !== undefined && relayerAvailable && !prefs.submitFromWallet

  // useFees stays plumbed in for the relayer-submit path (need cacheId at submit time even
  // though the display fee no longer comes from the quote on the direct path). For B4 the
  // shield-xchain gasless path needs the SOURCE chain's quote — fees vary per chain because
  // gas costs do (Base Sepolia ≠ Ethereum Sepolia). Pass `fromChainId` so useFees fetches the
  // matching schedule from `/fees?chainId=...`.
  const feeChainId =
    computedKind === 'shield-xchain' && useGasless ? fromChainId : undefined
  const { quote, isStale, refresh } = useFees({ chainId: feeChainId })
  // Display fee — for the gasless `shield` path this reads `quote.fees.shield`; for gasless
  // `shield-xchain` it reads `quote.fees.shieldXchain` from the source chain's quote. Direct
  // paths preserve their existing semantics (0 for hub shield, CCTP fast-fee estimate for
  // shield-xchain).
  const fee: bigint = userFeeForKind(computedKind, amount, quote, {
    gasless: useGasless,
  })
  // On-chain protocol fee — PrivacyPool's fee module takes ~50 bps off the shielded amount on
  // the hub regardless of submission path (gasless or direct). useDisplayFees reads
  // calculateShieldFee from the deployed fee module via wagmi; layered into computeFeeBreakdown
  // below as `protocolFee` so recipientReceives reflects the TRUE shielded value the user gets,
  // not just `amount - broadcasterFee`. nativeGas is also surfaced for the wallet-submit fallback
  // (gasless path doesn't pay native gas — Phase 6 hides that row).
  const { fees: displayFees, isLoading: feeLoading } = useDisplayFees(
    computedKind,
    amount,
    fromChainId,
    quote,
  )
  const protocolFee = displayFees.protocolFee
  // CCTP fast-fee — applies to BOTH direct and gasless cross-chain shield (CCTP V2 always
  // charges its fast-fee on a cross-chain mint regardless of how the burn was initiated).
  // Routed through its own channel rather than the broadcaster slot so the tooltip can label it
  // "CCTP fee" instead of "Relayer fee" (which would be misleading on the direct path where
  // there's no broadcaster). Zero on any same-chain shield.
  const cctpFee: bigint =
    computedKind === 'shield-xchain' ? cctpFastFeeForAmount(amount) : 0n
  // Per-kind fee math (recipient receives / user is debited / how much they can type) lives in
  // the shared `computeFeeBreakdown` helper. Both gasless paths use `fee-from-recipient` so
  // the entered `amount` IS what's deducted from the user's USDC balance, and the shielded
  // value is `amount - fee - protocolFee - cctpFee` (gasless xchain) or `amount - fee - protocolFee`
  // (everything else). The wrapper splits on-chain: `(amount - fee)` to the pool, which then
  // takes `protocolFee` from the shielded credit. Direct hub shield is `no-fee` so only
  // `protocolFee` deducts from the shielded value.
  const {
    recipientReceives: netAmount,
    totalDeducted,
    inputMax,
  } = computeFeeBreakdown(computedKind, amount, fee, max, {
    protocolFee: protocolFee + cctpFee,
    // Routes the `shield` kind through the gasless `fee-from-recipient` model when the wrapper
    // path is active — without this the helper falls back to `no-fee` and the tooltip's
    // "You'll deposit" line skips the broadcaster fee (recipientReceives misses one deduction).
    gasless: useGasless,
  })
  // Tooltip-ready breakdown — surfaces broadcaster fee + "You'll deposit" + "Total deducted"
  // bullets inside FeeBreakdownTooltip so the input UI stays clean (no inline FeeSummary rows).
  const flowBreakdown = {
    broadcasterFee: fee,
    cctpFee: cctpFee > 0n ? cctpFee : undefined,
    recipientReceives: netAmount,
    totalDeducted,
    recipientLabel: "You'll deposit",
  }
  // Minimum valid amount = the live fee. Below or equal to it the wrapper's `shieldAmount =
  // totalAmount - fee` would underflow / be zero. Surfaced via ShieldInputStep's `minAmount`
  // prop so the user can't type a value that would inevitably revert. Zero for no-fee paths.
  const minAmount: bigint = fee

  // Two useTx hooks mounted; only one gets a record per flow. Pattern mirrors SendModal +
  // UnshieldModal where same-chain vs cross-chain are sibling kinds.
  const txShield = useTx({ kind: 'shield' })
  const txShieldXchain = useTx({ kind: 'shield-xchain' })
  const activeTx =
    submittedKind === 'shield' ? txShield
    : submittedKind === 'shield-xchain' ? txShieldXchain
    : null
  const record = activeTx?.record ?? null

  // Reset local state on close so re-opening starts fresh.
  useEffect(() => {
    if (!isOpen) {
      setStep('input')
      setSubmitError(null)
      setErrorAtStep(undefined)
      setAmountStr('')
      setSubmittedKind(null)
    }
  }, [isOpen])

  // Once the tx record exists and reaches a terminal state, transition step accordingly.
  // Dep is `record?.executionState` rather than `record` so artifact patches (e.g. proofProgress
  // ticks, log-scan cursor advances on xchain) don't re-fire the effect needlessly. The body
  // only branches on executionState.
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
    setSubmitError(null)
    try {
      // Submit with a fresh cacheId — if the cached quote is within the staleness window the
      // modal sat through, re-quote first so the relayer doesn't reject with FEE_EXPIRED.
      const activeQuote = quote && !isStale ? quote : await refresh()
      if (!activeQuote) {
        throw new Error('Could not fetch a current fee quote — please try again.')
      }
      if (computedKind === 'shield') {
        setSubmittedKind('shield')
        // Phase B3: gasless meta only set when actually routing through the wrapper; absent
        // when direct-submit. The handler checks `meta.useGasless` to branch.
        if (useGasless && hubWrapperAddress !== undefined) {
          // Re-check against the FRESH fee. With fee-from-recipient semantics the entered
          // `amount` IS what gets pulled from the user (not `amount + fee`), so the balance
          // check is `amount > max`. The trickier race is when gas spiked between input and
          // submit and the new fee now equals or exceeds amount — the wrapper's
          // `shieldAmount = totalAmount - fee` would underflow. Fail fast with a clear copy.
          const liveFee = BigInt(activeQuote.fees.shield)
          if (amount > max) {
            throw new Error(
              `Insufficient USDC balance. You have ${formatUsdc(max)} USDC, attempted to deposit ${formatUsdc(amount)} USDC.`,
            )
          }
          if (amount <= liveFee) {
            throw new Error(
              `Relayer fee (${formatUsdc(liveFee)} USDC) increased to or above the deposit amount (${formatUsdc(amount)} USDC). Lower the fee by waiting for gas to drop, or raise the deposit amount.`,
            )
          }
          await txShield.submit({
            amount,
            feeCacheId: activeQuote.cacheId,
            fromChainId,
            useGasless: true,
            feeAmount: liveFee,
            wrapperAddress: hubWrapperAddress,
            permitDeadline: Math.floor(Date.now() / 1000) + PERMIT_DEADLINE_WINDOW_SEC,
          })
        } else {
          await txShield.submit({
            amount,
            feeCacheId: activeQuote.cacheId,
            fromChainId,
          })
        }
      } else {
        setSubmittedKind('shield-xchain')
        // Phase B4: same dispatch pattern as B3 for hub, but the fee comes from the source
        // chain's `shieldXchain` tier — useFees was already configured with `chainId=fromChainId`
        // above so `activeQuote` is the source-chain quote.
        if (useGasless && clientWrapperAddress !== undefined) {
          // Same submit-time race guard as the hub branch — see that comment block for the
          // full rationale. With fee-from-recipient the entered `amount` IS what's pulled.
          const liveFee = BigInt(activeQuote.fees.shieldXchain)
          if (amount > max) {
            throw new Error(
              `Insufficient USDC balance. You have ${formatUsdc(max)} USDC, attempted to deposit ${formatUsdc(amount)} USDC.`,
            )
          }
          if (amount <= liveFee) {
            throw new Error(
              `Relayer fee (${formatUsdc(liveFee)} USDC) increased to or above the deposit amount (${formatUsdc(amount)} USDC). Lower the fee by waiting for gas to drop, or raise the deposit amount.`,
            )
          }
          await txShieldXchain.submit({
            amount,
            feeCacheId: activeQuote.cacheId,
            fromChainId,
            useGasless: true,
            feeAmount: liveFee,
            wrapperAddress: clientWrapperAddress,
            permitDeadline: Math.floor(Date.now() / 1000) + PERMIT_DEADLINE_WINDOW_SEC,
          })
        } else {
          await txShieldXchain.submit({
            amount,
            feeCacheId: activeQuote.cacheId,
            fromChainId,
          })
        }
      }
      setStep('progress')
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Submit failed.')
      setStep('error')
      setErrorAtStep('review')
    }
  }

  if (!isOpen) return null

  // DepositOverlayShell renders a 3-segment indicator (Amount/Review/Confirm) — `progress`,
  // `complete`, and `error` all map to segment 3. `overlayIndicatorStatus` flips the bar green
  // on `complete` and red on `error`. Lavender otherwise. errorAtStep is no longer surfaced
  // through the shell (the legacy 4-segment bar used it); instead the ErrorStep itself owns
  // the retry button + copy.
  const indicatorStep = overlayIndicatorStep(step)
  const indicatorStatus = overlayIndicatorStatus(step)

  return (
    <DepositOverlayShell
      open={isOpen}
      onClose={close}
      dismissible={step !== 'progress'}
      flowLabel="Deposit"
      currentStep={indicatorStep}
      status={indicatorStatus}
    >
      {step === 'input' && (
        <>
          <ShieldInputStepContent
            fromChainId={fromChainId}
            onFromChainIdChange={setFromChainId}
            amountStr={amountStr}
            onAmountChange={setAmountStr}
            max={max}
            maxInput={inputMax}
            minAmount={minAmount}
            displayFees={displayFees}
            flowBreakdown={flowBreakdown}
            feeLoading={feeLoading}
            gaslessMode={useGasless}
          />
          <ShieldInputStepFooter
            amountStr={amountStr}
            maxInput={inputMax}
            minAmount={minAmount}
            onCancel={close}
            onContinue={() => setStep('review')}
          />
        </>
      )}
      {step === 'review' && (
        <ShieldReviewStep
          fromChainId={fromChainId}
          amount={amount}
          // Display "Fee" as the inclusive total — broadcaster + on-chain protocol fee + CCTP
          // (gasless shield-xchain only; direct shield-xchain already has CCTP in `fee`) — so
          // the user sees the same number that's used to derive `netAmount`. The tooltip below
          // the amount card already breaks it out into individual rows.
          fee={fee + protocolFee + cctpFee}
          netAmount={netAmount}
          onBack={() => setStep('input')}
          onConfirm={handleSubmit}
        />
      )}
      {step === 'progress' && <ProgressStep record={record} />}
      {step === 'complete' && <ShieldCompleteStep netAmount={netAmount} onDone={close} />}
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
      <RelayerStatusBanner isOpen={isOpen} />
    </DepositOverlayShell>
  )
}
