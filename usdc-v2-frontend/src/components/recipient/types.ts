/**
 * Type definitions for recipient address input components.
 */

export type AddressType = 'evm' | 'namada'

export interface RecipientAddressInputProps {
  value: string
  onChange: (address: string) => void
  onNameChange?: (name: string | null) => void // For saving name when submitting
  onNameValidationChange?: (isValid: boolean, error: string | null) => void // Validation state for name save
  addressType: AddressType // Determines which addresses to show
  validationError?: string | null
  autoFillAddress?: string | null // Address from wallet for auto-fill
  onAutoFill?: () => void
  disabled?: boolean
  placeholder?: string
  className?: string
}
