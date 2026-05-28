// ABOUTME: SendModal — pay someone in USDC, either privately (0zk → 0zk) or to an external wallet (0x). Picks among three kinds based on the tab + destination chain.
// ABOUTME: Mounts three useTx hooks (transfer-shielded / unshield-local / unshield-xchain); submitted-kind state locks the subscription for the rest of the flow. External-tab + xchain reuses unshield-xchain — same contract path, different UI entry.

import { useEffect, useState } from 'react'
import { useAtom, useAtomValue } from 'jotai'
import { openModalAtom } from '@/state/ui'
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
import { userFeeForKind } from '@/lib/relayer'
import { displayTxHash, txExplorerUrl } from '@/lib/explorer'
import { trackError } from '@/lib/telemetry'
import {
  ActionFlowShell,
  ProgressStep,
  ErrorStep,
  type FlowStep,
  type FlowVisibleStep,
} from '@/components/flow'
import { SendInputStep, type SendTab } from './SendInputStep'
import { SendReviewStep } from './SendReviewStep'
import { SendCompleteStep } from './SendCompleteStep'

type LocalStep = FlowStep
const STEPS: ReadonlyArray<FlowVisibleStep> = ['input', 'review', 'progress', 'complete']

type SubmittedKind = 'transfer-shielded' | 'unshield-local' | 'unshield-xchain'

function computeKind(tab: SendTab, destChainId: number, hubChainId: number): SubmittedKind {
  if (tab === 'private') return 'transfer-shielded'
  return destChainId === hubChainId ? 'unshield-local' : 'unshield-xchain'
}

export function SendModal() {
  const [openModal, setOpenModal] = useAtom(openModalAtom)
  const isOpen = openModal === 'payment'

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
  //   transfer-shielded → 0n (handler migrates to relayer-mediated in A4)
  //   unshield-local    → relayer's advertised USDC fee from the quote (A3+); 0n pre-quote-load
  //   unshield-xchain   → CCTP fast-fee estimate (~2 bps, proportional to amount)
  const fee: bigint = userFeeForKind(computedKind, amount, quote)
  const netAmount = amount > fee ? amount - fee : 0n

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
    setSubmitError(null)
    try {
      // Re-quote if the cached fee is stale — see ShieldModal for the rationale.
      const activeQuote = quote && !isStale ? quote : await refresh()
      if (!activeQuote) {
        throw new Error('Could not fetch a current fee quote — please try again.')
      }
      const feeCacheId = activeQuote.cacheId
      if (computedKind === 'transfer-shielded') {
        setSubmittedKind('transfer-shielded')
        await txTransfer.submit({
          amount,
          feeCacheId,
          recipient,
        })
      } else if (computedKind === 'unshield-local') {
        setSubmittedKind('unshield-local')
        // Freeze the broadcaster context with the rest of the submit state — same rationale as
        // UnshieldModal: the proof must embed these EXACT values to pass the relayer's verifier.
        await txUnshieldLocal.submit({
          amount,
          feeCacheId,
          recipient,
          broadcasterFeeAmount: BigInt(activeQuote.fees.unshield),
          broadcasterRailgunAddress: activeQuote.broadcasterRailgunAddress,
        })
      } else {
        setSubmittedKind('unshield-xchain')
        await txUnshieldXchain.submit({
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
      title="Send"
      step={step}
      steps={STEPS}
      errorAtStep={errorAtStep}
    >
      {step === 'input' && (
        <SendInputStep
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
          fee={fee}
          netAmount={netAmount}
          isFeeRefreshing={isStale}
          destDeploymentError={destDeploymentError}
          onCancel={close}
          onContinue={() => setStep('review')}
        />
      )}
      {step === 'review' && (
        <SendReviewStep
          tab={tab}
          destChainId={destChainId}
          recipient={recipient}
          amount={amount}
          fee={fee}
          netAmount={netAmount}
          isXchain={isXchain}
          submitBlockedReason={syncGate.reason}
          onBack={() => setStep('input')}
          onConfirm={handleSubmit}
        />
      )}
      {step === 'progress' && <ProgressStep record={record} />}
      {step === 'complete' && (
        <SendCompleteStep
          tab={tab}
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
