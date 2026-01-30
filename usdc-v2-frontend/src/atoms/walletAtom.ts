import { atom } from 'jotai'

export interface WalletState {
  metaMask: {
    isConnecting: boolean
    isConnected: boolean
    account?: string
    chainId?: number
    chainHex?: string
  }
  lastUpdated?: number
}

export const walletAtom = atom<WalletState>({
  metaMask: {
    isConnecting: false,
    isConnected: false,
    account: undefined,
    chainId: undefined,
    chainHex: undefined,
  },
  lastUpdated: undefined,
})

export const walletErrorAtom = atom<string | undefined>(undefined)
