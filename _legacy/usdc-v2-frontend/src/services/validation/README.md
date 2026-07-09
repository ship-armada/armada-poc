# Validation Service

A modular and reusable validation service for input validation across the USDC v2 frontend application.

## Overview

This service provides production-ready validation for:
- **Amounts**: Numeric validation with decimal precision, balance checks, and fee handling
- **Bech32 Addresses**: Proper bech32 validation with checksum verification (Namada, Noble, etc.)
- **EVM Addresses**: Ethereum address validation with EIP-55 checksum support

## Installation

The validation service is already integrated into the application. Import from:

```typescript
import { validateAmount, validateNamadaAddress, validateEvmAddress } from '@/services/validation'
```

## Usage

### Amount Validation

```typescript
import { validateAmount } from '@/services/validation'

// Basic validation
const result = validateAmount('10.50')
if (result.isValid) {
  console.log('Valid amount:', result.value)
} else {
  console.error('Error:', result.error)
}

// With balance check and fees
const result = validateAmount('50.00', {
  maxDecimals: 6,
  maxAmount: '100.00',
  estimatedFee: '0.12',
  minAmount: '0.01',
})
```

**Options:**
- `maxDecimals`: Maximum decimal places (default: 6 for USDC)
- `minAmount`: Minimum allowed amount
- `maxAmount`: Maximum allowed amount (e.g., available balance)
- `estimatedFee`: Fee to add when checking against maxAmount
- `allowScientificNotation`: Allow scientific notation (default: false)
- `errorMessages`: Custom error messages

### Bech32 Address Validation

```typescript
import { validateBech32Address, validateNamadaAddress } from '@/services/validation'

// Generic bech32 validation
const result = validateBech32Address('tnam1q...', { expectedHrp: 'tnam' })

// Namada-specific convenience function
const result = validateNamadaAddress('tnam1q...')
```

**Features:**
- Proper bech32 checksum validation
- HRP (Human-Readable Part) validation
- Extensible to support other HRPs (nam, noble, etc.)
- Automatic normalization to lowercase

### EVM Address Validation

```typescript
import { validateEvmAddress } from '@/services/validation'

const result = validateEvmAddress('0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb')
if (result.isValid) {
  console.log('Valid address:', result.value) // Checksummed address
}
```

**Features:**
- EIP-55 checksum validation
- Format validation (0x prefix + 40 hex characters)
- Returns checksummed address format
- Handles lowercase, uppercase, and checksummed inputs

### Convenience Functions

#### Deposit Form Validation

```typescript
import { validateDepositForm } from '@/services/validation'

const result = validateDepositForm(
  amount,
  availableBalance,
  estimatedFee,
  namadaAddress
)

if (!result.isValid) {
  if (result.amountError) {
    // Handle amount error
  }
  if (result.addressError) {
    // Handle address error
  }
}
```

#### Payment Form Validation

```typescript
import { validatePaymentForm } from '@/services/validation'

const result = validatePaymentForm(
  amount,
  availableBalance,
  estimatedFee,
  evmAddress
)
```

#### Shield Amount Validation

```typescript
import { validateShieldAmount } from '@/services/validation'

const result = validateShieldAmount(amount, availableBalance)
```

## Migration Guide

### From Old Validation Functions

The new service is backward compatible. Simply update imports:

**Before (deprecated):**
```typescript
// Old imports - no longer available
import { validateDepositForm } from '@/utils/depositValidation'
import { validatePaymentForm } from '@/utils/paymentValidation'
```

**After:**
```typescript
import { validateDepositForm, validatePaymentForm } from '@/services/validation'
```

The function signatures remain the same, so no other changes are needed.

### Replacing Ad-Hoc Validation

**Before:**
```typescript
if (!amount || parseFloat(amount) <= 0) {
  return
}
if (parseFloat(amount) > parseFloat(balance)) {
  return
}
```

**After:**
```typescript
import { validateAmount } from '@/services/validation'

const result = validateAmount(amount, {
  maxAmount: balance,
})
if (!result.isValid) {
  // Show error: result.error
  return
}
```

## Error Messages

All validators return structured error messages:

```typescript
interface ValidationResult {
  isValid: boolean
  error: string | null
  value?: string // Normalized value when valid
}
```

Error messages are user-friendly and actionable:
- "Please enter an amount"
- "Amount must be greater than zero"
- "Amount exceeds available balance. Maximum: $50.00"
- "Invalid Namada address format. Expected address starting with \"tnam\""
- "Invalid EVM address format. Expected: 0x followed by 40 hexadecimal characters"

## Input Guards

The validation service includes input sanitization functions that prevent invalid characters from being typed in the first place. These provide a better user experience by blocking invalid input at the source.

### Amount Input Guards

```typescript
import { handleAmountInputChange } from '@/services/validation'

<input
  type="text"
  value={amount}
  onChange={(e) => handleAmountInputChange(e, setAmount, 6)}
  inputMode="decimal"
/>
```

**Features:**
- Only allows numeric characters (0-9)
- Allows a single decimal point
- Limits decimal places (configurable, default: 6)
- Blocks all other characters (letters, special characters, spaces)

### Bech32 Address Input Guards

```typescript
import { handleBech32InputChange } from '@/services/validation'

<input
  type="text"
  value={address}
  onChange={(e) => handleBech32InputChange(e, setAddress)}
/>
```

**Features:**
- Only allows lowercase letters (a-z) and digits (0-9)
- Automatically converts to lowercase
- Blocks spaces, special characters, and uppercase letters
- Preserves bech32 separator '1'

### EVM Address Input Guards

```typescript
import { handleEvmAddressInputChange } from '@/services/validation'

<input
  type="text"
  value={address}
  onChange={(e) => handleEvmAddressInputChange(e, setAddress)}
/>
```

**Features:**
- Only allows hexadecimal characters (0-9, a-f)
- Automatically handles '0x' prefix
- Limits to 40 hex characters (EVM address length)
- Converts to lowercase for consistency
- Blocks invalid characters (g-z, special characters, spaces)

## Best Practices

1. **Use Input Guards**: Always use input guards to prevent invalid characters from being typed
2. **Validate Early**: Validate inputs as users type (on blur/change) for better UX
3. **Validate on Submit**: Always validate again on form submission
4. **Show Errors Clearly**: Display validation errors near the input field
5. **Use Normalized Values**: Use `result.value` when valid (normalized format)
6. **Custom Error Messages**: Override default messages when needed for context

## Testing

Comprehensive tests are available in `__tests__/`:
- `amountValidator.test.ts
- bech32Validator.test.ts
- evmAddressValidator.test.ts

Run tests with:
```bash
npm test
```

## Architecture

```
src/services/validation/
├── types.ts              # TypeScript interfaces
├── errors.ts             # Standardized error messages
├── amountValidator.ts    # Amount validation logic
├── bech32Validator.ts   # Bech32 address validation
├── evmAddressValidator.ts # EVM address validation
├── index.ts              # Main export (unified API)
└── __tests__/            # Test files
```

## Dependencies

- `bech32`: Bech32 encoding/decoding library
- `ethers`: EVM address validation and checksumming

Both libraries are already installed in the project.

## Future Enhancements

- Support for additional HRPs (nam, noble, etc.)
- Async validation (e.g., on-chain address verification)
- Localization support for error messages
- Custom validation rules per use case

