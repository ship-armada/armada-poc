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

/**
 * Seconds left in the commit window by chain time (`windowEnd - blockTimestamp`),
 * floored at 0. Undefined until both chain values have loaded, so consumers show
 * their no-deadline copy instead of a made-up countdown.
 */
export function commitWindowSecondsLeft(
  windowEnd: number,
  blockTimestamp: number,
): number | undefined {
  if (windowEnd <= 0 || blockTimestamp <= 0) return undefined
  return Math.max(0, windowEnd - blockTimestamp)
}
