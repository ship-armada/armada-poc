// ABOUTME: Local-dev-only mock unshielded USDC balance for deposit UI testing. Persisted in localStorage; ignored outside local mode.
// ABOUTME: useBalances applies the override to every chain when enabled — real on-chain balance is unchanged.

import { atomWithStorage } from 'jotai/utils'
import { parseUsdcInput } from '@/lib/format'

/** Default mock: 1000 USDC (raw 6-decimal). */
export const DEFAULT_DEV_MOCK_BALANCE_RAW = 1_000_000_000n

export interface DevMockBalanceValue {
  enabled: boolean
  /** Human-readable USDC amount (e.g. "1000") for the Debug panel input. */
  amountUsdc: string
}

export const DEFAULT_DEV_MOCK_BALANCE: DevMockBalanceValue = {
  enabled: false,
  amountUsdc: '1000',
}

export const devMockBalanceAtom = atomWithStorage<DevMockBalanceValue>(
  'armada-interface.devMockBalance',
  DEFAULT_DEV_MOCK_BALANCE,
)

/** Parse the Debug panel amount; falls back to 1000 USDC when empty or invalid. */
export function getDevMockBalanceRaw(value: DevMockBalanceValue): bigint {
  const { value: parsed, error } = parseUsdcInput(value.amountUsdc)
  if (!error && parsed > 0n) return parsed
  return DEFAULT_DEV_MOCK_BALANCE_RAW
}
