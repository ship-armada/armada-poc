import { atom } from 'jotai'
import type { EvmChainsFile } from '@/config/chains'

export interface AppInitState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  error?: string
}

export const appInitAtom = atom<AppInitState>({ status: 'idle' })
export const chainConfigAtom = atom<EvmChainsFile | undefined>(undefined)

// Store the preferred chain key for balance fetching (set by Deposit page)
// This allows the Deposit page to communicate its selected chain to the global balance service,
// which polling can then use instead of falling back to MetaMask chainId or default chain
export const preferredChainKeyAtom = atom<string | undefined>(undefined)

// Toggle to enable/disable automatic shielded sync and balance calculation during polling
// When false, polling will skip shielded operations (user can still manually trigger sync)
// Default: false (disabled)
export const autoShieldedSyncEnabledAtom = atom<boolean>(false)

// Store the current deposit recipient tnam address
// This allows any part of the app to access the current recipient address
// Updated by the Deposit component when the user enters/changes the recipient address
export const depositRecipientAddressAtom = atom<string | undefined>(undefined)

// Store the Noble forwarding fallback address preference
// This is an optional address that will be used when generating Noble forwarding addresses
// Defaults to undefined (empty string when used)
// Note: This atom is used by Settings page only. Deposit page uses depositFallbackSelectionAtom.
export const nobleFallbackAddressAtom = atom<string | undefined>(undefined)

// Store the deposit page fallback address selection
// Tracks whether to use custom address (from Settings) or derived address (from MetaMask)
export interface DepositFallbackSelection {
  source: 'custom' | 'derived' | 'none'
  address: string | undefined
}

export const depositFallbackSelectionAtom = atom<DepositFallbackSelection>({
  source: 'none',
  address: undefined,
})
