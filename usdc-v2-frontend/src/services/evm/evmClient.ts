export async function getEvmProvider() {
  // TODO: Return ethers.js BrowserProvider once dependency is added.
  if (typeof window === 'undefined' || !(window as typeof window & { ethereum?: unknown }).ethereum) {
    throw new Error('MetaMask provider not available')
  }
  return (window as typeof window & { ethereum: unknown }).ethereum
}

export async function getEvmAccount(): Promise<string | undefined> {
  // TODO: Request accounts via provider once ethers is integrated.
  return undefined
}
