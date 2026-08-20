// ABOUTME: ShieldModal — dumb renderer for the shield (deposit) flow. Owns open/close chrome only.
// ABOUTME: All form/fee/submit/step orchestration lives in useShieldFlow; the modal just wires steps to it.

import { useAtom } from 'jotai'
import { openModalAtom } from '@/state/ui'
import { useShieldFlow } from '@/hooks/useShieldFlow'
import { displayTxHash, txExplorerUrl } from '@/lib/explorer'
import {
  ProgressStep,
  ErrorStep,
  overlayIndicatorStep,
  overlayIndicatorStatus,
} from '@/components/flow'
import { FlowShell } from '@/components/flow/FlowShell'
import { useFlowExit } from '@/components/flow/useFlowExit'
import { RelayerStatusBanner } from '@/components/RelayerStatusBanner'
import { ShieldInputStepContent, ShieldInputStepFooter } from './ShieldInputStep'
import { ShieldReviewStep } from './ShieldReviewStep'
import { ShieldCompleteStep } from './ShieldCompleteStep'

export function ShieldModal() {
  const [openModal, setOpenModal] = useAtom(openModalAtom)
  const isOpen = openModal === 'shield'
  const flow = useShieldFlow(isOpen)

  // Route the close through useFlowExit so FlowShell plays its slide-down before unmounting. The
  // atom stays set (isOpen true) until the animation completes, which keeps the step content frozen.
  const { exiting, requestClose: close } = useFlowExit(() => setOpenModal(null))

  if (!isOpen) return null

  const { record } = flow
  const explorerUrl = txExplorerUrl(record?.walletContext.sourceChainId, displayTxHash(record))

  // FlowShell's ModalShell renders a 3-segment Steps indicator (Amount/Review/Confirm) — `progress`,
  // `complete`, and `error` all map to segment 3. `overlayIndicatorStatus` flips the bar green on
  // `complete` and red on `error`; lavender otherwise.
  const indicatorStep = overlayIndicatorStep(flow.step)
  const indicatorStatus = overlayIndicatorStatus(flow.step)

  return (
    <FlowShell
      open={isOpen}
      onClose={close}
      exiting={exiting}
      stepKey={flow.step}
      flowLabel="Shield"
      currentStep={indicatorStep}
      status={indicatorStatus}
    >
      {flow.step === 'input' && (
        <>
          <ShieldInputStepContent
            fromChainId={flow.fromChainId}
            onFromChainIdChange={flow.setFromChainId}
            amountStr={flow.amountStr}
            onAmountChange={flow.setAmountStr}
            max={flow.max}
            maxInput={flow.inputMax}
            minAmount={flow.minAmount}
            displayFees={flow.displayFees}
            flowBreakdown={flow.flowBreakdown}
            feeLoading={flow.feeLoading}
            gaslessMode={flow.useGasless}
          />
          <ShieldInputStepFooter
            amountStr={flow.amountStr}
            maxInput={flow.inputMax}
            minAmount={flow.minAmount}
            onCancel={close}
            onContinue={flow.onContinueToReview}
          />
        </>
      )}
      {flow.step === 'review' && (
        <ShieldReviewStep
          fromChainId={flow.fromChainId}
          amount={flow.amount}
          // Inclusive "Fee" (broadcaster + on-chain protocol + CCTP) — the same number used to
          // derive netAmount; the tooltip below the amount card breaks it into individual rows.
          fee={flow.feeInclusive}
          netAmount={flow.netAmount}
          walletAddress={flow.evmAddress}
          walletProvider={flow.walletProvider}
          shieldedAddress={flow.shieldedAddress}
          isSubmitting={flow.isSubmitting}
          duplicateWarning={flow.duplicateWarning}
          onBack={flow.onBackToInput}
          onConfirm={flow.submit}
        />
      )}
      {flow.step === 'progress' && <ProgressStep record={record} />}
      {flow.step === 'complete' && (
        <ShieldCompleteStep
          fromChainId={flow.fromChainId}
          amount={flow.amount}
          fee={flow.feeInclusive}
          netAmount={flow.netAmount}
          walletAddress={flow.evmAddress}
          walletProvider={flow.walletProvider}
          shieldedAddress={flow.shieldedAddress}
          confirmedAt={record?.updatedAt ?? Date.now()}
          explorerUrl={explorerUrl}
          onViewExplorer={() => {
            if (explorerUrl) window.open(explorerUrl, '_blank', 'noopener,noreferrer')
          }}
          onGoToDashboard={close}
        />
      )}
      {flow.step === 'error' && (
        <ErrorStep
          error={record?.artifacts.error ?? null}
          message={flow.submitError ?? undefined}
          explorerUrl={explorerUrl}
          primaryLabel={flow.errorPrimaryLabel}
          onRetry={flow.onErrorPrimary}
        />
      )}
      <RelayerStatusBanner isOpen={isOpen} />
    </FlowShell>
  )
}
