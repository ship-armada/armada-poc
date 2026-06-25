// ABOUTME: sessionStorage marker for an in-flight claim/refund tx, owned by the claim page.
// ABOUTME: Lets ClaimFlowV2 reconstruct its in-progress (or failed) state after navigating away and back, instead of resetting to the Review form.

/** A claim/refund tx that has been broadcast but whose outcome the claim page
 *  hasn't yet shown to the user in-page. Kept until the page consumes the
 *  outcome (success/failure acknowledged) so a remount can re-derive state. */
export interface ClaimInFlight {
  hash: string
  mode: 'arm' | 'refund'
  /** Connected wallet that submitted it — so a switched wallet doesn't inherit it. */
  address: string
  sentAt: number
}

const KEY = 'armada.crowdfund.claimInFlight'

export function setClaimInFlight(marker: ClaimInFlight): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(marker))
  } catch {
    // best-effort — never break the claim flow on storage failure
  }
}

/** The in-flight claim marker, but only if it belongs to `address`. */
export function getClaimInFlight(address: string | null): ClaimInFlight | null {
  if (!address) return null
  try {
    const raw = sessionStorage.getItem(KEY)
    if (!raw) return null
    const marker = JSON.parse(raw) as ClaimInFlight
    return marker.address?.toLowerCase() === address.toLowerCase() ? marker : null
  } catch {
    return null
  }
}

export function clearClaimInFlight(): void {
  try {
    sessionStorage.removeItem(KEY)
  } catch {
    // best-effort — see setClaimInFlight
  }
}
