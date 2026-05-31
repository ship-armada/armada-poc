// ABOUTME: ShieldModal — orchestrator for the shield (deposit) action flow. Owns step + form state; renders ActionFlowShell with InputStep/ReviewStep/ProgressStep/CompleteStep/ErrorStep.
// ABOUTME: Dispatches between same-chain shield (hub source) and cross-chain shield-xchain (client source) based on fromChainId; B3 routes hub shield through GaslessShieldWrapper when available.

import { useEffect, useState } from 'react'
import { useAtom, useAtomValue } from 'jotai'
import { useQuery } from '@tanstack/react-query'
import { openModalAtom } from '@/state/ui'
import { preferencesAtom } from '@/state/preferences'
import { useTx } from '@/hooks/useTx'
import { useFees } from '@/hooks/useFees'
import { useRelayerHealth } from '@/hooks/useRelayerHealth'
import { userFeeForKind } from '@/lib/relayer'
import { useBalances } from '@/hooks/useBalances'
import { getNetworkConfig } from '@/config/network'
import { loadDeployments } from '@/config/deployments'
import { parseUsdcInput } from '@/lib/format'
import { displayTxHash, txExplorerUrl } from '@/lib/explorer'
import {
  ActionFlowShell,
  ProgressStep,
  ErrorStep,
  type FlowStep,
  type FlowVisibleStep,
} from '@/components/flow'
import { RelayerStatusBanner } from '@/components/RelayerStatusBanner'
import { ShieldInputStep } from './ShieldInputStep'
import { ShieldReviewStep } from './ShieldReviewStep'
import { ShieldCompleteStep } from './ShieldCompleteStep'

type LocalStep = FlowStep
type SubmittedKind = 'shield' | 'shield-xchain'

const STEPS: ReadonlyArray<FlowVisibleStep> = ['input', 'review', 'progress', 'complete']

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

  // Phase B3 — gasless path is available only for same-chain hub shield (the `shield` kind),
  // and only when ALL of: wrapper deployed for the chain, relayer health is acceptable, user
  // hasn't opted into wallet-override. shield-xchain still goes through its (Phase A) handler
  // unchanged; B4 will add gasless there.
  const hubWrapperAddress = deployments.data?.hub.contracts.gaslessShieldWrapper
  const useGasless: boolean =
    computedKind === 'shield' &&
    hubWrapperAddress !== undefined &&
    relayerAvailable &&
    !prefs.submitFromWallet

  // useFees stays plumbed in for the relayer-submit path (need cacheId at submit time even
  // though the display fee no longer comes from the quote on the direct path).
  const { quote, isStale, refresh } = useFees()
  // Display fee — for the gasless `shield` path this reads `quote.fees.shield` (relayer's
  // per-chain quote); for direct submit it's 0 (user pays own ETH gas). shield-xchain stays on
  // the CCTP fast-fee estimate via `userFeeForKind`'s existing branch.
  const fee: bigint = userFeeForKind(computedKind, amount, quote, {
    gasless: useGasless,
  })
  // Floor at 0 — when amount < fee (e.g. user typed a value smaller than the CCTP fee on
  // shield-xchain) the raw subtraction would render as a negative figure in the FeeSummary.
  // The contract rejects on-chain anyway; clamping keeps the UI honest until the user types a
  // viable amount.
  const netAmount = amount > fee ? amount - fee : 0n

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
          await txShield.submit({
            amount,
            feeCacheId: activeQuote.cacheId,
            fromChainId,
            useGasless: true,
            feeAmount: BigInt(activeQuote.fees.shield),
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
        await txShieldXchain.submit({
          amount,
          feeCacheId: activeQuote.cacheId,
          fromChainId,
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
      title="Deposit"
      step={step}
      steps={STEPS}
      errorAtStep={errorAtStep}
    >
      {step === 'input' && (
        <ShieldInputStep
          fromChainId={fromChainId}
          onFromChainIdChange={setFromChainId}
          amountStr={amountStr}
          onAmountChange={setAmountStr}
          max={max}
          fee={fee}
          netAmount={netAmount}
          isFeeRefreshing={isStale}
          onCancel={close}
          onContinue={() => setStep('review')}
        />
      )}
      {step === 'review' && (
        <ShieldReviewStep
          fromChainId={fromChainId}
          amount={amount}
          fee={fee}
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
          onRetry={errorAtStep === 'review' ? () => setStep('review') : () => activeTx?.retry()}
        />
      )}
      <RelayerStatusBanner isOpen={isOpen} />
    </ActionFlowShell>
  )
}
