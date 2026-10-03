// ABOUTME: Derives the Progress card's sale status pill and the pre-open window check.
// ABOUTME: Pre-open is keyed on chain time vs windowStart — the deploy loads ARM long before the open.

/** True while an active sale's commit window hasn't opened yet (chain time
 *  before `windowStart`). `armLoaded` can't signal this: the deploy loads ARM
 *  well before the window opens. False until both values have loaded, and for
 *  a cancelled or finalized sale. */
export function isPreOpen(phase: number, windowStart: number, blockTimestamp: number): boolean {
  if (phase !== 0 || windowStart <= 0 || blockTimestamp <= 0) return false
  return blockTimestamp < windowStart
}

/** Derive the Progress card's lifecycle status pill from the contract phase
 *  plus window-open state. The "Active" badge in the mockup was hardcoded;
 *  here we map the five real states ('OPENS SOON' before the commit window
 *  opens, 'ACTIVE' during it, 'CLOSED' after the window ends but before
 *  finalization, then 'FINALIZED' / 'CANCELLED' once the launch team rules) so
 *  the user can tell at a glance which phase the sale is in. */
export function formatSaleStatusLabel(
  phase: number,
  windowOpen: boolean,
  preOpen: boolean,
): { label: string; dot: 'active' | 'lavender' | 'neutral' | 'warning' } {
  if (phase === 1) return { label: 'FINALIZED', dot: 'lavender' }
  if (phase === 2) return { label: 'CANCELLED', dot: 'warning' }
  if (preOpen) return { label: 'OPENS SOON', dot: 'lavender' }
  if (!windowOpen) return { label: 'CLOSED', dot: 'neutral' }
  return { label: 'ACTIVE', dot: 'active' }
}
