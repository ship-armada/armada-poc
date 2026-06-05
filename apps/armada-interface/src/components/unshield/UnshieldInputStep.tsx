// ABOUTME: Unshield amount step — DepositAmountCard + locked recipient row (full-viewport withdraw flow).

import { useMemo } from 'react'
import { Button } from '@armada/ui'
import { DepositAmountCard } from '@/components/deposit/DepositAmountCard/DepositAmountCard'
import { depositOverlayShellStyles } from '@/components/deposit/DepositOverlayShell/DepositOverlayShell'
import { GasBalanceNotice } from '@/components/ui/GasBalanceNotice'
import { getAllChainIdentities, getNetworkConfig } from '@/config/network'
import { formatUsdcPlain, parseUsdcInput, usdcInputErrorMessage } from '@/lib/format'
import { isEvmAddress } from '@/lib/address'
import type { DisplayFees } from '@/lib/fees/displayFees'
import type { FlowFeeBreakdown } from '@/components/ui/FeeBreakdownTooltip'
import { useGasBalanceWarning } from '@/hooks/useGasBalanceWarning'
import { hasActiveAmount } from '@/utils/amountInput'
import shieldStyles from '@/components/shield/ShieldInputStep.module.css'
import { WithdrawRecipientField } from './WithdrawRecipientField'
import styles from './UnshieldInputStep.module.css'

const questionClass = shieldStyles.question

export interface UnshieldInputStepProps {
  destChainId: number
  onDestChainIdChange: (chainId: number) => void
  walletAddress: string | null
  amountStr: string
  onAmountChange: (next: string) => void
  max: bigint
  maxInput: bigint
  balanceLabel: string
  balanceSyncing: boolean
  displayFees: DisplayFees
  flowBreakdown?: FlowFeeBreakdown
  feeLoading?: boolean
  gasChainId: number
  onCancel: () => void
  onContinue: () => void
}

export function UnshieldInputStepContent({
  destChainId,
  onDestChainIdChange,
  walletAddress,
  amountStr,
  onAmountChange,
  maxInput,
  balanceLabel,
  balanceSyncing,
  displayFees,
  flowBreakdown,
  feeLoading = false,
  gasChainId,
}: Pick<
  UnshieldInputStepProps,
  | 'destChainId'
  | 'onDestChainIdChange'
  | 'walletAddress'
  | 'amountStr'
  | 'onAmountChange'
  | 'maxInput'
  | 'balanceLabel'
  | 'balanceSyncing'
  | 'displayFees'
  | 'flowBreakdown'
  | 'feeLoading'
  | 'gasChainId'
>) {
  const hubChainId = getNetworkConfig().hub.chainId
  const isXchain = destChainId !== hubChainId
  const chains = useMemo(
    () => getAllChainIdentities().map((c) => ({ chainId: c.chainId, label: c.name })),
    [],
  )
  const gasWarning = useGasBalanceWarning(gasChainId)

  const { value: amount, error: parseError } = parseUsdcInput(amountStr)
  const tooMuch = amount > maxInput
  const amountError = usdcInputErrorMessage(parseError)
    ?? (tooMuch ? 'Amount exceeds your private balance after fees.' : undefined)

  return (
    <div className={styles.withdrawContent}>
      <div className={styles.amountGroup}>
        <p className={questionClass}>How much USDC do you want to withdraw?</p>
        <DepositAmountCard
          chains={chains}
          chainId={destChainId}
          onChainIdChange={onDestChainIdChange}
          amount={amountStr}
          onAmountChange={onAmountChange}
          balance={balanceLabel}
          displayFees={displayFees}
          flowBreakdown={flowBreakdown}
          feeLoading={feeLoading}
          onMax={
            balanceSyncing
              ? undefined
              : () => onAmountChange(formatUsdcPlain(maxInput))
          }
          error={amountError}
          amountAriaLabel="Withdrawal amount"
        />
        {gasWarning.show ? (
          <GasBalanceNotice
            nativeSymbol={gasWarning.nativeSymbol}
            formattedBalance={gasWarning.formattedBalance}
          />
        ) : null}
      </div>
      <div className={styles.recipientSlot}>
        <WithdrawRecipientField address={walletAddress} />
      </div>
      {isXchain ? (
        <div className={styles.xchainNotice}>
          Cross-chain withdrawal takes a few minutes for the CCTP confirmation.
        </div>
      ) : null}
    </div>
  )
}

export function UnshieldInputStepFooter({
  walletAddress,
  amountStr,
  maxInput,
  balanceSyncing,
  onCancel,
  onContinue,
}: Pick<
  UnshieldInputStepProps,
  'walletAddress' | 'amountStr' | 'maxInput' | 'balanceSyncing' | 'onCancel' | 'onContinue'
>) {
  const { value: amount, error: parseError } = parseUsdcInput(amountStr)
  const tooMuch = amount > maxInput
  const recipientTrimmed = walletAddress?.trim() ?? ''
  const canReview =
    !balanceSyncing &&
    hasActiveAmount(amountStr) &&
    !tooMuch &&
    !parseError &&
    isEvmAddress(recipientTrimmed)

  return (
    <div className={depositOverlayShellStyles.buttonRow}>
      <Button
        variant="secondary"
        size="lg"
        label="Cancel"
        showIcon={false}
        onClick={onCancel}
      />
      <Button
        variant="primary"
        size="lg"
        label="Review"
        showIcon={false}
        disabled={!canReview}
        onClick={onContinue}
      />
    </div>
  )
}

export function UnshieldInputStep(props: UnshieldInputStepProps) {
  return (
    <>
      <UnshieldInputStepContent {...props} />
      <UnshieldInputStepFooter {...props} />
    </>
  )
}
