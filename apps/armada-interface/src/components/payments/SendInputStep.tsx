// ABOUTME: Send amount step — tab switcher, recipient, DepositAmountCard (full-viewport send flow).

import { useMemo } from 'react'
import { Button } from '@armada/ui'
import { DepositAmountCard } from '@/components/deposit/DepositAmountCard/DepositAmountCard'
import { depositOverlayShellStyles } from '@/components/deposit/DepositOverlayShell/DepositOverlayShell'
import { GasBalanceNotice, RecipientInput, Tabs } from '@/components/ui'
import type { DisplayFees } from '@/lib/fees/displayFees'
import type { FlowFeeBreakdown } from '@/components/ui/FeeBreakdownTooltip'
import { useGasBalanceWarning } from '@/hooks/useGasBalanceWarning'
import { getAllChainIdentities, getNetworkConfig } from '@/config/network'
import { formatUsdcPlain, parseUsdcInput, usdcInputErrorMessage } from '@/lib/format'
import { isEvmAddress, isShieldedAddress, validateEvmAddress } from '@/lib/address'
import { hasActiveAmount } from '@/utils/amountInput'
import shieldStyles from '@/components/shield/ShieldInputStep.module.css'
import styles from './SendInputStep.module.css'

export type SendTab = 'private' | 'external'

const TABS = [
  { id: 'private' as const, label: 'Private (0zk)' },
  { id: 'external' as const, label: 'External wallet' },
] as const

export function SendModeTabs({
  tab,
  onTabChange,
}: {
  tab: SendTab
  onTabChange: (next: SendTab) => void
}) {
  return <Tabs items={TABS} selected={tab} onSelect={onTabChange} ariaLabel="Send mode" />
}

export interface SendInputStepProps {
  tab: SendTab
  onTabChange: (next: SendTab) => void
  destChainId: number
  onDestChainIdChange: (chainId: number) => void
  recipient: string
  onRecipientChange: (next: string) => void
  amountStr: string
  onAmountChange: (next: string) => void
  max: bigint
  maxInput: bigint
  displayFees: DisplayFees
  flowBreakdown?: FlowFeeBreakdown
  feeLoading?: boolean
  gasChainId: number
  /**
   * When true, the relayer pays gas — suppresses the GasBalanceNotice. All three SendModal
   * kinds (`transfer-shielded`, `unshield-local`, `unshield-xchain`) route through the relayer
   * by default; the user pays native gas only when they've toggled Preferences →
   * "Submit transactions from my wallet". Mirrors `ShieldModal` / `UnshieldModal`.
   */
  gaslessMode?: boolean
  destDeploymentError?: string
  onCancel: () => void
  onContinue: () => void
}

export function SendInputStepContent({
  tab,
  onTabChange,
  destChainId,
  onDestChainIdChange,
  recipient,
  onRecipientChange,
  amountStr,
  onAmountChange,
  max,
  maxInput,
  displayFees,
  flowBreakdown,
  feeLoading = false,
  gasChainId,
  gaslessMode = true,
  destDeploymentError,
}: Pick<
  SendInputStepProps,
  | 'tab'
  | 'onTabChange'
  | 'destChainId'
  | 'onDestChainIdChange'
  | 'recipient'
  | 'onRecipientChange'
  | 'amountStr'
  | 'onAmountChange'
  | 'max'
  | 'maxInput'
  | 'displayFees'
  | 'flowBreakdown'
  | 'feeLoading'
  | 'gasChainId'
  | 'gaslessMode'
  | 'destDeploymentError'
>) {
  const hubChainId = getNetworkConfig().hub.chainId
  const hubChain = getNetworkConfig().hub
  const isXchain = tab === 'external' && destChainId !== hubChainId

  const allChains = useMemo(
    () => getAllChainIdentities().map((c) => ({ chainId: c.chainId, label: c.name })),
    [],
  )
  const chains = tab === 'external'
    ? allChains
    : [{ chainId: hubChain.chainId, label: hubChain.name }]
  const cardChainId = tab === 'external' ? destChainId : hubChainId

  const { value: amount, error: parseError } = parseUsdcInput(amountStr)
  const gasWarning = useGasBalanceWarning(gasChainId)
  // Only surface the gas notice when the user actually pays gas themselves. All three SendModal
  // kinds default to the relayer path; the wallet-submit override flips `gaslessMode` to false.
  const showGasNotice = !gaslessMode && gasWarning.show
  const tooMuch = amount > maxInput
  const amountError = usdcInputErrorMessage(parseError)
    ?? (tooMuch ? 'Amount exceeds your private balance after fees.' : undefined)

  const recipientTrimmed = recipient.trim()
  const evmValidation = tab === 'external' ? validateEvmAddress(recipientTrimmed) : null
  const recipientValid =
    tab === 'private' ? isShieldedAddress(recipientTrimmed) : (evmValidation?.valid ?? false)
  const recipientInvalid = recipientTrimmed.length > 0 && !recipientValid
  const recipientError = recipientInvalid
    ? tab === 'private'
      ? 'Enter a valid shielded address (0zk…).'
      : evmValidation?.error === 'checksum'
        ? 'Address checksum mismatch — double-check for typos.'
        : 'Enter a valid EVM address (0x… 42 chars).'
    : undefined

  return (
    <div className={styles.sendContent}>
      <p className={shieldStyles.question}>How much USDC do you want to send?</p>
      <SendModeTabs tab={tab} onTabChange={onTabChange} />
      <div className={styles.amountGroup}>
        <DepositAmountCard
          chains={chains}
          chainId={cardChainId}
          onChainIdChange={tab === 'external' ? onDestChainIdChange : undefined}
          amount={amountStr}
          onAmountChange={onAmountChange}
          balance={formatUsdcPlain(max)}
          displayFees={displayFees}
          flowBreakdown={flowBreakdown}
          feeLoading={feeLoading}
          onMax={() => onAmountChange(formatUsdcPlain(maxInput))}
          error={amountError}
          amountAriaLabel="Send amount"
        />
        {showGasNotice ? (
          <GasBalanceNotice
            nativeSymbol={gasWarning.nativeSymbol}
            formattedBalance={gasWarning.formattedBalance}
          />
        ) : null}
      </div>
      <div className={styles.recipientSlot}>
        <RecipientInput
          label="Recipient address"
          value={recipient}
          onValueChange={onRecipientChange}
          error={recipientError}
          placeholder={tab === 'private' ? '0zk…' : '0x…'}
        />
      </div>
      {isXchain ? (
        <div className={styles.xchainNotice}>
          Cross-chain payment takes a few minutes for the CCTP confirmation.
        </div>
      ) : null}
      {destDeploymentError ? (
        <div className={styles.destError} role="alert">
          {destDeploymentError}
        </div>
      ) : null}
    </div>
  )
}

export function SendInputStepFooter({
  tab,
  recipient,
  amountStr,
  maxInput,
  destDeploymentError,
  onCancel,
  onContinue,
}: Pick<
  SendInputStepProps,
  | 'tab'
  | 'recipient'
  | 'amountStr'
  | 'maxInput'
  | 'destDeploymentError'
  | 'onCancel'
  | 'onContinue'
>) {
  const { value: amount, error: parseError } = parseUsdcInput(amountStr)
  const tooMuch = amount > maxInput
  const recipientTrimmed = recipient.trim()
  const recipientValid =
    tab === 'private' ? isShieldedAddress(recipientTrimmed) : isEvmAddress(recipientTrimmed)
  const canReview =
    hasActiveAmount(amountStr) &&
    !tooMuch &&
    !parseError &&
    recipientValid &&
    !destDeploymentError

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

export function SendInputStep(props: SendInputStepProps) {
  return (
    <>
      <SendInputStepContent {...props} />
      <SendInputStepFooter {...props} />
    </>
  )
}
