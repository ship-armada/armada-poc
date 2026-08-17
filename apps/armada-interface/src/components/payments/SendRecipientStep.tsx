// ABOUTME: Send/Withdraw recipient step — editable address (0zk or 0x) + a destination-chain selector shown only for public 0x recipients.
// ABOUTME: Address format drives the flow kind downstream; a privacy indicator tells the user whether this send stays shielded (0zk) or exits to a public wallet (0x).

import { Button } from '@/design'
import { depositOverlayShellStyles } from '@/components/deposit/DepositOverlayShell/DepositOverlayShell'
import { ChainSelect, RecipientInput } from '@/components/ui'
import { isShieldedAddress, validateEvmAddress } from '@/lib/address'
import shieldStyles from '@/components/shield/ShieldInputStep.module.css'
import styles from './SendRecipientStep.module.css'

/** Which flow the shared Send/Withdraw modal is running as — drives minimal copy differences. */
export type SendFlowVariant = 'send' | 'withdraw'

export interface SendRecipientStepProps {
  variant: SendFlowVariant
  recipient: string
  onRecipientChange: (next: string) => void
  destChainId: number
  onDestChainIdChange: (chainId: number) => void
  /** Surfaced when the chosen public destination chain has no deployment manifest. */
  destDeploymentError?: string
  onCancel: () => void
  onContinue: () => void
}

export function SendRecipientStep({
  variant,
  recipient,
  onRecipientChange,
  destChainId,
  onDestChainIdChange,
  destDeploymentError,
  onCancel,
  onContinue,
}: SendRecipientStepProps) {
  const recipientTrimmed = recipient.trim()
  const isPrivate = isShieldedAddress(recipientTrimmed)
  const evmValidation = validateEvmAddress(recipientTrimmed)
  // A public recipient is a valid 0x address that is NOT a shielded 0zk address.
  const isPublic = !isPrivate && evmValidation.valid
  const recipientValid = isPrivate || isPublic
  const recipientInvalid = recipientTrimmed.length > 0 && !recipientValid
  const recipientError = recipientInvalid
    ? evmValidation.error === 'checksum'
      ? 'Address checksum mismatch — double-check for typos.'
      : 'Enter a valid shielded (0zk…) or public wallet (0x…) address.'
    : undefined

  const question =
    variant === 'withdraw'
      ? 'Where do you want to withdraw your USDC?'
      : 'Who do you want to send USDC to?'

  const canContinue = recipientValid && !destDeploymentError

  return (
    <div className={styles.root}>
      <p className={shieldStyles.question}>{question}</p>
      <RecipientInput
        label="Recipient address"
        value={recipient}
        onValueChange={onRecipientChange}
        error={recipientError}
        placeholder="0zk… or 0x…"
      />
      {recipientValid ? (
        <div className={styles.privacyIndicator} role="status">
          {isPrivate
            ? 'Private transfer — stays inside the shielded pool.'
            : 'Public transfer — funds leave the shielded pool to a wallet address.'}
        </div>
      ) : null}
      {/* Chain selection only applies to public 0x recipients; a 0zk transfer stays on the hub. */}
      {isPublic ? (
        <div className={styles.chainSlot}>
          <ChainSelect
            label="Destination chain"
            value={destChainId}
            onChange={onDestChainIdChange}
          />
        </div>
      ) : null}
      {destDeploymentError ? (
        <div className={styles.destError} role="alert">
          {destDeploymentError}
        </div>
      ) : null}
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
          label="Continue"
          showIcon={false}
          disabled={!canContinue}
          onClick={onContinue}
        />
      </div>
    </div>
  )
}
