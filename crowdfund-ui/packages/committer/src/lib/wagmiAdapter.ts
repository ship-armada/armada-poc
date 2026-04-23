// ABOUTME: Converts wagmi WalletClient (viem) to ethers v6 JsonRpcSigner.
// ABOUTME: Allows existing ethers-based contract code to work with wagmi wallet.

import { BrowserProvider, JsonRpcSigner } from 'ethers'
import type { WalletClient } from 'viem'

/**
 * Adapts a viem WalletClient (from wagmi) into an ethers v6 JsonRpcSigner.
 * This is a well-known pattern that avoids rewriting every `new Contract(addr, abi, signer)` call.
 */
export function walletClientToSigner(walletClient: WalletClient): JsonRpcSigner {
  const { account, chain, transport } = walletClient
  if (!chain) throw new Error('WalletClient has no chain')
  if (!account) throw new Error('WalletClient has no account')
  const network = {
    chainId: chain.id,
    name: chain.name,
    ensAddress: chain.contracts?.ensRegistry?.address,
  }
  const provider = new BrowserProvider(transport, network)
  return new JsonRpcSigner(provider, account.address)
}
