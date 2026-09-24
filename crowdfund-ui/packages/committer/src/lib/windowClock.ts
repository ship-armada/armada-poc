// ABOUTME: Converts the chain-time commit-window end onto the device clock for live countdowns.
// ABOUTME: Keeps a skewed device clock (or an Anvil time warp) from desyncing the counter vs chain-time gating.

/**
 * The commit-window end expressed on the local clock (unix seconds): the
 * chain's remaining time (`windowEnd - blockTimestamp`) added to the moment the
 * block timestamp was observed locally. A countdown that ticks against
 * `Date.now()` then reaches zero when the chain window closes, not when the
 * device clock passes the raw chain `windowEnd`.
 */
export function localWindowEndUnix(
  windowEnd: number,
  blockTimestamp: number,
  observedAtMs: number,
): number {
  return Math.round(observedAtMs / 1000) + (windowEnd - blockTimestamp)
}
