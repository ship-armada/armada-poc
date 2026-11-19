// ABOUTME: Copy for the claim modal's below-minimum gate (before finalize, when the sale missed its minimum).
// ABOUTME: Mentions per-hop allocation limits only where they can cause the shortfall (not under priority fill).

import { formatUsdc } from '@armada/crowdfund-shared'

/** Body text for the "Sale ended below minimum" gate. Under priority fill only low demand can miss
 *  the minimum; with hop ceilings or a floor, allocation limits can cause it too. */
export function belowMinimumMessage(priorityFill: boolean, minSale: bigint, committed: bigint): string {
  const reason = priorityFill
    ? `The crowdfund didn't reach the ${formatUsdc(minSale)} minimum fund.`
    : `The crowdfund didn't reach the ${formatUsdc(minSale)} minimum fund after per-hop allocation limits.`
  return committed > 0n
    ? `${reason} Once it's finalized, you'll be able to claim a refund of your committed ${formatUsdc(committed)} from here.`
    : `${reason} Once it's finalized, all committed USDC will be refundable to the addresses that participated.`
}
