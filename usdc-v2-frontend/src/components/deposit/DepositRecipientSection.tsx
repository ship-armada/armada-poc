import { AlertCircle } from 'lucide-react'
import { RecipientAddressInput } from '@/components/recipient/RecipientAddressInput'

interface DepositRecipientSectionProps {
  address: string
  onAddressChange: (address: string) => void
  onNameChange: (name: string | null) => void
  onNameValidationChange: (isValid: boolean, error: string | null) => void
  validationError: string | null
  isAnyTxActive: boolean
}

export function DepositRecipientSection({
  address,
  onAddressChange,
  onNameChange,
  onNameValidationChange,
  validationError,
  isAnyTxActive,
}: DepositRecipientSectionProps) {
  return (
    <div className="flex-1 card card-xl">
      <div className="flex items-baseline justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground bg-muted px-2 py-1 rounded">
            Step 2
          </span>
          <label className="text-sm font-semibold">Deposit to</label>
        </div>
      </div>
      <p className="text-sm text-muted-foreground mb-3">
        Namada address where your USDC will arrive
      </p>

      <RecipientAddressInput
        value={address}
        onChange={onAddressChange}
        onNameChange={onNameChange}
        onNameValidationChange={onNameValidationChange}
        addressType="namada"
        validationError={validationError}
        disabled={isAnyTxActive}
      />

      {/* Validation error */}
      {validationError && address.trim() !== '' && (
        <div className="mt-3 flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
          <span className="flex-1">{validationError}</span>
        </div>
      )}
    </div>
  )
}
