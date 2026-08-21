// ABOUTME: ShieldModal — Shield/Unshield tabbed flow. Dumb renderer composing useShieldFlow + useUnshieldFlow.
// ABOUTME: Shield = public → private; Unshield = private → your own EVM wallet (to-chain picker). The typed amount carries across the tab toggle.

import { useState } from 'react'
import { useAtom, useAtomValue } from 'jotai'
import { openModalAtom } from '@/state/ui'
import { preferencesAtom } from '@/state/preferences'
import { useShieldFlow } from '@/hooks/useShieldFlow'
import { useUnshieldFlow } from '@/hooks/useUnshieldFlow'
import { getNetworkConfig } from '@/config/network'
import { formatUsdcPlain } from '@/lib/format'
import { displayTxHash, txExplorerUrl } from '@/lib/explorer'
import {
  ProgressStep,
  ErrorStep,
  overlayIndicatorStep,
  overlayIndicatorStatus,
  type FlowStep,
} from '@/components/flow'
import { FlowShell } from '@/components/flow/FlowShell'
import { useFlowExit } from '@/components/flow/useFlowExit'
import { RelayerStatusBanner } from '@/components/RelayerStatusBanner'
import {
  ShieldAmountStepContent,
  ShieldAmountStepFooter,
  type ShieldTab,
} from './ShieldAmountStep'
import { ShieldReviewStep } from './ShieldReviewStep'
import { ShieldWalletStep } from './ShieldWalletStep'
import { ShieldCompleteStep } from './ShieldCompleteStep'
import { SendReviewStep } from '@/components/payments/SendReviewStep'
import { SendCompleteStep } from '@/components/payments/SendCompleteStep'

// Shield has a dedicated Wallet step (approve/sign); Unshield is relayer-submitted (no wallet sign).
const SHIELD_TAB_STEPS = ['Amount', 'Review', 'Wallet', 'Confirm']
const UNSHIELD_TAB_STEPS = ['Amount', 'Review', 'Confirm']

export function ShieldModal() {
  const [openModal, setOpenModal] = useAtom(openModalAtom)
  const isOpen = openModal === 'shield' || openModal === 'unshield'
  const initialTab: ShieldTab = openModal === 'unshield' ? 'unshield' : 'shield'
  const prefs = useAtomValue(preferencesAtom)
  const hubChainId = getNetworkConfig().hub.chainId

  const [tab, setTab] = useState<ShieldTab>(initialTab)
  // Re-sync the tab to the entry point whenever the modal (re)opens.
  const [wasOpen, setWasOpen] = useState(false)
  if (isOpen !== wasOpen) {
    setWasOpen(isOpen)
    if (isOpen) setTab(initialTab)
  }

  const shieldFlow = useShieldFlow(isOpen)
  const unshieldFlow = useUnshieldFlow(isOpen)
  const { exiting, requestClose: close } = useFlowExit(() => setOpenModal(null))

  function handleTabChange(next: ShieldTab) {
    if (next === tab) return
    // Carry the typed amount across the toggle (mockup behavior — the amount is shared).
    if (next === 'unshield') unshieldFlow.setAmountStr(shieldFlow.amountStr)
    else shieldFlow.setAmountStr(unshieldFlow.amountStr)
    setTab(next)
  }

  if (!isOpen) return null

  const isShield = tab === 'shield'
  // Common flow surface — both controllers expose these; the divergent bits are read off the
  // specific flow inside each tab branch.
  const active = isShield ? shieldFlow : unshieldFlow
  const step = active.step
  const record = active.record
  const explorerUrl = txExplorerUrl(record?.walletContext.sourceChainId, displayTxHash(record))

  // Per-tab step indicator: shield has the extra Wallet segment (4), unshield doesn't (3). The
  // unshield step is always a FlowStep (never 'wallet'), so the shared helpers apply there.
  const steps = isShield ? SHIELD_TAB_STEPS : UNSHIELD_TAB_STEPS
  const currentStep = isShield
    ? step === 'input'
      ? 1
      : step === 'review'
        ? 2
        : step === 'wallet'
          ? 3
          : 4
    : overlayIndicatorStep(step as FlowStep)
  const status = isShield
    ? step === 'complete'
      ? 'confirmed'
      : step === 'error'
        ? 'error'
        : 'default'
    : overlayIndicatorStatus(step as FlowStep)

  return (
    <FlowShell
      open={isOpen}
      onClose={close}
      exiting={exiting}
      stepKey={step}
      flowLabel={isShield ? 'Shield' : 'Withdraw'}
      steps={steps}
      currentStep={currentStep}
      status={status}
    >
      {step === 'input' && (
        <>
          <ShieldAmountStepContent
            tab={tab}
            onTabChange={handleTabChange}
            chainId={isShield ? shieldFlow.fromChainId : unshieldFlow.toChainId}
            onChainIdChange={isShield ? shieldFlow.setFromChainId : unshieldFlow.setToChainId}
            amountStr={active.amountStr}
            onAmountChange={active.setAmountStr}
            balance={formatUsdcPlain(active.max)}
            pendingBalance={
              !isShield && unshieldFlow.pendingUsdc > 0n
                ? formatUsdcPlain(unshieldFlow.pendingUsdc)
                : undefined
            }
            maxInput={active.inputMax}
            minAmount={isShield ? shieldFlow.minAmount : 0n}
            displayFees={active.displayFees}
            flowBreakdown={active.flowBreakdown}
            feeLoading={active.feeLoading}
            gaslessMode={isShield ? shieldFlow.useGasless : !prefs.submitFromWallet}
            gasChainId={isShield ? shieldFlow.fromChainId : hubChainId}
          />
          <ShieldAmountStepFooter
            amountStr={active.amountStr}
            maxInput={active.inputMax}
            minAmount={isShield ? shieldFlow.minAmount : 0n}
            onCancel={close}
            onContinue={active.onContinueToReview}
          />
        </>
      )}

      {step === 'review' &&
        (isShield ? (
          <ShieldReviewStep
            fromChainId={shieldFlow.fromChainId}
            amount={shieldFlow.amount}
            fee={shieldFlow.feeInclusive}
            netAmount={shieldFlow.netAmount}
            walletAddress={shieldFlow.evmAddress}
            walletProvider={shieldFlow.walletProvider}
            shieldedAddress={shieldFlow.shieldedAddress}
            isSubmitting={shieldFlow.isSubmitting}
            duplicateWarning={shieldFlow.duplicateWarning}
            feeUpdated={shieldFlow.feeChanged}
            onBack={shieldFlow.onBackToInput}
            onConfirm={shieldFlow.submit}
          />
        ) : (
          <SendReviewStep
            variant="withdraw"
            recipient={unshieldFlow.recipient}
            armadaAddress={unshieldFlow.shieldedAddress}
            amount={unshieldFlow.amount}
            fee={unshieldFlow.feeInclusive}
            totalDeducted={unshieldFlow.totalDeducted}
            networkName={unshieldFlow.networkName}
            recipientWalletProvider={unshieldFlow.recipientWalletProvider}
            submitBlockedReason={unshieldFlow.submitBlockedReason}
            feeUpdated={unshieldFlow.feeChanged}
            onBack={unshieldFlow.onBackToInput}
            isSubmitting={unshieldFlow.isSubmitting}
            onConfirm={unshieldFlow.submit}
          />
        ))}

      {/* Dedicated wallet step — Shield only (Unshield is relayer-submitted, no wallet sign). */}
      {step === 'wallet' && <ShieldWalletStep steps={shieldFlow.walletSteps} />}

      {step === 'progress' && (
        <ProgressStep record={record} sendVariant={isShield ? undefined : 'withdraw'} />
      )}

      {step === 'complete' &&
        (isShield ? (
          <ShieldCompleteStep
            fromChainId={shieldFlow.fromChainId}
            amount={shieldFlow.amount}
            fee={shieldFlow.feeInclusive}
            netAmount={shieldFlow.netAmount}
            walletAddress={shieldFlow.evmAddress}
            walletProvider={shieldFlow.walletProvider}
            shieldedAddress={shieldFlow.shieldedAddress}
            confirmedAt={record?.updatedAt ?? Date.now()}
            explorerUrl={explorerUrl}
            onViewExplorer={() => {
              if (explorerUrl) window.open(explorerUrl, '_blank', 'noopener,noreferrer')
            }}
            onGoToDashboard={close}
          />
        ) : (
          <SendCompleteStep
            variant="withdraw"
            recipient={unshieldFlow.recipient}
            armadaAddress={unshieldFlow.shieldedAddress}
            amount={unshieldFlow.amount}
            fee={unshieldFlow.feeInclusive}
            totalDeducted={unshieldFlow.totalDeducted}
            networkName={unshieldFlow.networkName}
            recipientWalletProvider={unshieldFlow.recipientWalletProvider}
            confirmedAt={record?.updatedAt ?? Date.now()}
            explorerUrl={explorerUrl}
            onViewExplorer={() => {
              if (explorerUrl) window.open(explorerUrl, '_blank', 'noopener,noreferrer')
            }}
            onGoToDashboard={close}
          />
        ))}

      {step === 'error' && (
        <ErrorStep
          error={record?.artifacts.error ?? null}
          message={active.submitError ?? undefined}
          explorerUrl={explorerUrl}
          primaryLabel={active.errorPrimaryLabel}
          onRetry={active.onErrorPrimary}
        />
      )}
      <RelayerStatusBanner isOpen={isOpen} />
    </FlowShell>
  )
}
