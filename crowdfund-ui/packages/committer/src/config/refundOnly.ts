// ABOUTME: Address of the cancelled first-sale (Sale 1) crowdfund whose refunds the committer lets wallets claim.
// ABOUTME: Mainnet uses the built-in address; other networks read an optional env override for rehearsals.

import { getNetworkMode, type NetworkMode } from './network'

// TODO: remove the first-sale refund feature (this module, lib/refundOnlyClaim, the /refund route,
// RefundNotice and their validateEnv rules) once the Sale 1 contract's USDC balance reaches 0, or at
// the review date the team sets. Refunds never expire on-chain, so there is no deadline to wait for.

/** Sale 1, the first (cancelled) crowdfund on Ethereum mainnet. Built in rather than configured: the
 *  refund panel asks users to send a transaction to it, so no deploy setting may change it. */
export const SALE1_CROWDFUND_MAINNET = '0xB4b0BBac50Df6c9479180AA788dAd8f88D520163'

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

/**
 * The crowdfund whose refunds the committer offers, or null when the feature is off. Mainnet always
 * returns the built-in Sale 1 address (any override is ignored, and validateEnv rejects one). Sepolia
 * and local builds use `VITE_REFUND_ONLY_CROWDFUND_ADDRESS` when it is a well-formed address.
 */
export function resolveRefundOnlyCrowdfundAddress(
  network: NetworkMode,
  override: string | undefined,
): string | null {
  if (network === 'mainnet') return SALE1_CROWDFUND_MAINNET
  const value = override?.trim()
  return value && ADDRESS_RE.test(value) ? value : null
}

export function getRefundOnlyCrowdfundAddress(): string | null {
  return resolveRefundOnlyCrowdfundAddress(
    getNetworkMode(),
    import.meta.env.VITE_REFUND_ONLY_CROWDFUND_ADDRESS as string | undefined,
  )
}
