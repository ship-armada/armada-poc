import { RecipientAddressInput } from '@/components/recipient/RecipientAddressInput'

interface SendPaymentRecipientSectionProps {
  address: string
  onAddressChange: (address: string) => void
  recipientName: string | null
  onRecipientNameChange: (name: string | null) => void
  onNameValidationChange: (isValid: boolean, error: string | null) => void
  validationError: string | null
  autoFillAddress: string | undefined
  onAutoFill: () => void
  disabled: boolean
}

export function SendPaymentRecipientSection({
  address,
  onAddressChange,
  onRecipientNameChange,
  onNameValidationChange,
  validationError,
  autoFillAddress,
  onAutoFill,
  disabled,
}: SendPaymentRecipientSectionProps) {
  return (
    <div className="flex-1 card card-xl">
      <div className="flex items-baseline justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground bg-muted px-2 py-1 rounded">
            Step 2
          </span>
          <label className="text-sm font-semibold">Recipient address</label>
        </div>
      </div>
      <p className="text-sm text-muted-foreground mb-3">
        Where your USDC will be sent
      </p>
      <RecipientAddressInput
        value={address}
        onChange={onAddressChange}
        onNameChange={onRecipientNameChange}
        onNameValidationChange={onNameValidationChange}
        addressType="evm"
        validationError={validationError}
        autoFillAddress={autoFillAddress}
        onAutoFill={onAutoFill}
        disabled={disabled}
      />
    </div>
  )
}

