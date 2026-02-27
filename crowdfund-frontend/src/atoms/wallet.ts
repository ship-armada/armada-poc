// ABOUTME: Jotai atoms for wallet/account state management.
// ABOUTME: Supports both Anvil account selector (local) and MetaMask (Sepolia).
import { atom } from 'jotai'
import type { AnvilAccount } from '@/config/accounts'

export interface WalletState {
  mode: 'anvil' | 'metamask'
  anvilAccount: AnvilAccount | null
  metaMaskAddress: string | null
  metaMaskChainId: number | null
  isConnecting: boolean
}

export const walletAtom = atom<WalletState>({
  mode: 'anvil',
  anvilAccount: null,
  metaMaskAddress: null,
  metaMaskChainId: null,
  isConnecting: false,
})

/** Derived atom: current address regardless of wallet mode */
export const currentAddressAtom = atom((get) => {
  const w = get(walletAtom)
  return w.mode === 'anvil' ? w.anvilAccount?.address ?? null : w.metaMaskAddress
})
