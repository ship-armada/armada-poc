// ABOUTME: Type declarations for MetaMask's window.ethereum provider.
// ABOUTME: Enables TypeScript support for wallet connection without additional packages.

interface EthereumProvider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>
  on?(event: string, handler: (...args: any[]) => void): void
  removeListener?(event: string, handler: (...args: any[]) => void): void
  isMetaMask?: boolean
}

declare global {
  interface Window {
    ethereum?: EthereumProvider
  }
}

export {}
