// ABOUTME: Converts a viem wallet/connector client to an ethers v6 JsonRpcSigner.
// ABOUTME: Allows existing ethers-based contract code to work with wagmi wallet.

import { BrowserProvider, JsonRpcSigner, type Eip1193Provider } from 'ethers'
import type { Account, Chain } from 'viem'

/** Minimal shape shared by viem's WalletClient (from `useWalletClient`) and
 *  the connector client returned by wagmi's `getConnectorClient` action. Both
 *  carry the `request`-capable transport ethers needs, but their TS types
 *  differ, so accept the structural intersection and cast at the boundary. */
type SignerClient = { account?: Account; chain?: Chain; transport: unknown }

/**
 * Adapts a viem client (from wagmi) into an ethers v6 JsonRpcSigner.
 * This is a well-known pattern that avoids rewriting every `new Contract(addr, abi, signer)` call.
 */
export function walletClientToSigner(client: SignerClient): JsonRpcSigner {
  const { account, chain, transport } = client
  if (!chain) throw new Error('Wallet client has no chain')
  if (!account) throw new Error('Wallet client has no account')
  const network = {
    chainId: chain.id,
    name: chain.name,
    ensAddress: chain.contracts?.ensRegistry?.address,
  }
  const provider = new BrowserProvider(transport as Eip1193Provider, network)
  return new JsonRpcSigner(provider, account.address)
}
