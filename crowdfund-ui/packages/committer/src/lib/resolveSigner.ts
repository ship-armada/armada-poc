// ABOUTME: Imperative signer resolution at transaction time via wagmi's getConnectorClient action.
// ABOUTME: Bypasses useWalletClient's cached query, which can stay undefined for a whole session after a fresh connect (wagmi #2784 / #3825).

import type { JsonRpcSigner } from 'ethers'
import { getConnectorClient, switchChain } from 'wagmi/actions'
import { getHubChainId, getHubNetworkLabel } from '@/config/network'
import { walletClientToSigner } from './wagmiAdapter'
import { isUserRejection } from './txWait'

/** wagmi error-class check by name — `instanceof` is brittle across the
 *  wagmi / @wagmi/core package boundary (duplicate class identities). */
function errName(err: unknown): string | undefined {
  return (err as { name?: string } | null)?.name
}

/**
 * Resolve an ethers signer directly from the connected wagmi connector.
 *
 * The flows prefer the hook-derived signer when it exists; this is the
 * fallback for when `useWalletClient().data` never resolves — a known wagmi
 * failure mode after a fresh connect, where the cached client query errors
 * (e.g. the wallet's live chain briefly disagrees with the requested chain)
 * and, with staleTime Infinity, never refetches for the session.
 *
 * On a live-chain mismatch, asks the wallet to switch to the hub chain and
 * retries once — newer MetaMask per-dapp network selection can leave the
 * wallet's live chain out of sync with wagmi's recorded connection chain, and
 * a switch prompt is the actionable way out. All other errors propagate to
 * the caller, which surfaces them via describeSignerError.
 */
export async function resolveSigner(): Promise<JsonRpcSigner> {
  // Dynamic import: config/wagmi executes RainbowKit's getDefaultConfig at
  // module load. Deferring it to call time keeps this module side-effect-free
  // for component tests that stub the flows' signers.
  const { wagmiConfig } = await import('@/config/wagmi')
  const chainId = getHubChainId()
  try {
    const client = await getConnectorClient(wagmiConfig, { chainId })
    return walletClientToSigner(client)
  } catch (err) {
    if (errName(err) !== 'ConnectorChainMismatchError') throw err
    await switchChain(wagmiConfig, { chainId })
    const client = await getConnectorClient(wagmiConfig, { chainId })
    return walletClientToSigner(client)
  }
}

/** Map a resolveSigner failure to an actionable user-facing message. */
export function describeSignerError(err: unknown): string {
  if (isUserRejection(err)) {
    return `Network switch declined — switch to ${getHubNetworkLabel()} in your wallet and retry.`
  }
  if (errName(err) === 'ConnectorNotConnectedError') {
    return 'Wallet not connected — reconnect and retry.'
  }
  const short = (err as { shortMessage?: string } | null)?.shortMessage
  const message = short ?? (err instanceof Error ? err.message : String(err))
  return `Wallet not ready — ${message}`
}
