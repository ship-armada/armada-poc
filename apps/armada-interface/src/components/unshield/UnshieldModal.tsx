// ABOUTME: UnshieldModal — withdraw private USDC to an EVM address. Selects unshield-local or unshield-xchain based on destination chain.
// ABOUTME: Two useTx hooks are mounted (one per kind); submit picks the right one. Record subscription follows the kind that was submitted.

import { useEffect, useRef, useState } from 'react'
import { useAtom, useAtomValue } from 'jotai'
import { openModalAtom } from '@/state/ui'
import { evmAddressAtom, shieldedUsdcAtom } from '@/state/wallet'
import { useTx } from '@/hooks/useTx'
import { useFees } from '@/hooks/useFees'
import { useSpendableSyncGate } from '@/hooks/useSpendableSyncGate'
import { getNetworkConfig } from '@/config/network'
import { parseUsdcInput } from '@/lib/format'
import { displayTxHash, txExplorerUrl } from '@/lib/explorer'
import { userFeeForKind } from '@/lib/relayer'
import {
  ActionFlowShell,
  ProgressStep,
  ErrorStep,
  type FlowStep,
  type FlowVisibleStep,
} from '@/components/flow'
import { UnshieldInputStep } from './UnshieldInputStep'
import { UnshieldReviewStep } from './UnshieldReviewStep'
import { UnshieldCompleteStep } from './UnshieldCompleteStep'

type LocalStep = FlowStep

const STEPS: ReadonlyArray<FlowVisibleStep> = ['input', 'review', 'progress', 'complete']

type SubmittedKind = 'unshield-local' | 'unshield-xchain'

export function UnshieldModal() {
  const [openModal, setOpenModal] = useAtom(openModalAtom)
  const isOpen = openModal === 'unshield'

  // Form state.
  const hubChainId = getNetworkConfig().hub.chainId
  const connectedEvm = useAtomValue(evmAddressAtom)
  const [destChainId, setDestChainId] = useState<number>(hubChainId)
  const [recipient, setRecipient] = useState<string>('')
  const [amountStr, setAmountStr] = useState<string>('')

  // Flow state.
  const [step, setStep] = useState<LocalStep>('input')
  const [errorAtStep, setErrorAtStep] = useState<FlowVisibleStep | undefined>(undefined)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [submittedKind, setSubmittedKind] = useState<SubmittedKind | null>(null)
  // One-shot guard so the connected-EVM prefill only runs on the modal's rising
  // edge — otherwise clearing the recipient would immediately refill from the effect.
  const didPrefillRef = useRef(false)

  // Source data.
  const shieldedUsdc = useAtomValue(shieldedUsdcAtom)
  const max = shieldedUsdc ?? 0n
  const { value: amount } = parseUsdcInput(amountStr)
  const { quote, isStale, refresh } = useFees()
  // Gate Confirm while the initial shielded-balance sync is incomplete (or failed). Reading
  // here so the Review step always reflects the current state — if sync completes while the
  // user is on Review, the button un-disables on the next render.
  const syncGate = useSpendableSyncGate()

  // Two hooks mounted; whichever kind we submit to gets a record. The other stays idle.
  const txLocal = useTx({ kind: 'unshield-local' })
  const txXchain = useTx({ kind: 'unshield-xchain' })
  const activeTx = submittedKind === 'unshield-local' ? txLocal : submittedKind === 'unshield-xchain' ? txXchain : null
  const record = activeTx?.record ?? null

  const computedKind: SubmittedKind = destChainId === hubChainId ? 'unshield-local' : 'unshield-xchain'
  // Display fee per (kind, amount, quote):
  //   unshield-local  → relayer's advertised USDC fee from the quote (A3+); 0n pre-quote-load.
  //   unshield-xchain → CCTP fast-fee estimate (~2 bps, proportional to amount). Quote ignored.
  const fee: bigint = userFeeForKind(computedKind, amount, quote)
  const netAmount = amount > fee ? amount - fee : 0n

  // Pre-fill recipient from the connected EVM wallet on the modal's rising edge only,
  // so the user can clear the field afterwards without it getting repopulated.
  useEffect(() => {
    if (!isOpen) return
    if (didPrefillRef.current) return
    didPrefillRef.current = true
    if (!recipient && connectedEvm) setRecipient(connectedEvm)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen])

  // Reset local state on close.
  useEffect(() => {
    if (!isOpen) {
      setStep('input')
      setSubmitError(null)
      setErrorAtStep(undefined)
      setAmountStr('')
      setSubmittedKind(null)
      didPrefillRef.current = false
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
    setSubmitError(null)
    try {
      const activeQuote = quote && !isStale ? quote : await refresh()
      if (!activeQuote) {
        throw new Error('Could not fetch a current fee quote — please try again.')
      }
      const feeCacheId = activeQuote.cacheId
      if (computedKind === 'unshield-local') {
        setSubmittedKind('unshield-local')
        // Freeze the broadcaster context with the rest of the submit state. The proof must embed
        // these EXACT values to pass the relayer's verifier — re-deriving them at handler time
        // would risk drift if the quote rolls over between submit and proof-build.
        await txLocal.submit({
          amount,
          feeCacheId,
          recipient,
          broadcasterFeeAmount: BigInt(activeQuote.fees.unshield),
          broadcasterRailgunAddress: activeQuote.broadcasterRailgunAddress,
        })
      } else {
        setSubmittedKind('unshield-xchain')
        await txXchain.submit({
          amount,
          feeCacheId,
          toChainId: destChainId,
          recipient,
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
      title="Withdraw"
      step={step}
      steps={STEPS}
      errorAtStep={errorAtStep}
    >
      {step === 'input' && (
        <UnshieldInputStep
          destChainId={destChainId}
          onDestChainIdChange={setDestChainId}
          recipient={recipient}
          onRecipientChange={setRecipient}
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
        <UnshieldReviewStep
          destChainId={destChainId}
          recipient={recipient}
          amount={amount}
          fee={fee}
          netAmount={netAmount}
          isXchain={computedKind === 'unshield-xchain'}
          submitBlockedReason={syncGate.reason}
          onBack={() => setStep('input')}
          onConfirm={handleSubmit}
        />
      )}
      {step === 'progress' && <ProgressStep record={record} />}
      {step === 'complete' && (
        <UnshieldCompleteStep
          destChainId={destChainId}
          recipient={recipient}
          netAmount={netAmount}
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
