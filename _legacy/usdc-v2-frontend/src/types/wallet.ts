export interface EvmWalletInfo {
  address: string
  chainId?: number
  chainIdHex?: string
  chainName?: string
}

export type WalletConnection = {
  evm?: EvmWalletInfo
  connectedAt: number
}

export interface AppSettings {
  preferredEvmChain?: string
  preferredTheme: 'light' | 'dark' | 'system'
  enableNotifications: boolean
}
