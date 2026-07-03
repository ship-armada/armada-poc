// ABOUTME: Unified contract-write submit — mobile via wagmi (chain-pinned), desktop via ethers after a live hub-chain assertion.
// ABOUTME: Centralizes the mobile/desktop split so no write path can broadcast to the wrong chain when the wallet switches networks mid-flow.

import type { Contract, Signer, TransactionResponse } from 'ethers'
import { isMobileBrowser } from '@/lib/isMobileBrowser'
import { submitTxViaWagmi } from '@/lib/mobileTxSubmit'
import { getHubChainId, getHubNetworkLabel } from '@/config/network'

/** Distinguish the wrong-chain guard error so callers/copy can special-case it. */
export function isWrongChainError(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'WRONG_CHAIN'
}

/**
 * Assert the wallet's LIVE chain is the hub chain before a desktop ethers send.
 *
 * The desktop ethers path — unlike the mobile wagmi path, which pins `chainId`
 * on `sendTransaction` — broadcasts to whatever chain the injected wallet is
 * currently on, and the pipeline doesn't re-check the chain between steps. If the
 * user switched networks mid-flow, a send to the crowdfund address on the wrong
 * chain can return a status-1 receipt (no code at that address ⇒ no revert) and be
 * shown as a successful commit while nothing landed on the hub.
 *
 * We read the live chain via a direct `eth_chainId` request rather than
 * `provider.getNetwork()`: the wagmi→ethers `BrowserProvider` is built with a
 * STATIC network (see `wagmiAdapter`), so `getNetwork()` returns the
 * construction-time chain and would miss a live switch. A provider that can't be
 * queried is left un-asserted (non-blocking) so we never wedge a legitimate send.
 */
export async function assertHubChain(signer: Signer): Promise<void> {
  const provider = signer.provider as
    | { send?: (method: string, params: unknown[]) => Promise<unknown> }
    | null
  if (!provider?.send) return
  const hex = (await provider.send('eth_chainId', [])) as string
  const live = Number.parseInt(hex, 16)
  if (Number.isFinite(live) && live !== getHubChainId()) {
    throw Object.assign(
      new Error(`Wrong network — switch to ${getHubNetworkLabel()} and retry.`),
      { code: 'WRONG_CHAIN' as const },
    )
  }
}

/**
 * Submit a contract write. Mobile routes through wagmi's `sendTransaction`
 * (chain-pinned, and it triggers the WalletConnect app redirect); desktop goes
 * through the ethers signer after asserting the wallet is on the hub chain.
 * Returns an ethers-`TransactionResponse`-shaped object either way, so the shared
 * send/wait engine (`sendAndWaitTx`) is unchanged.
 */
export async function submitWrite(
  contract: Contract,
  method: string,
  args: readonly unknown[],
  signer: Signer,
): Promise<TransactionResponse> {
  if (isMobileBrowser()) {
    return submitTxViaWagmi(contract, method, args)
  }
  await assertHubChain(signer)
  // Dynamic method call — ethers' Contract Proxy resolves `contract[method]` to
  // the write method (same as the direct `contract.commit(...)` call this
  // replaced), so it works on a real Contract and on plain-object test doubles.
  const write = (contract as unknown as Record<
    string,
    (...a: unknown[]) => Promise<TransactionResponse>
  >)[method]
  return write(...args)
}
