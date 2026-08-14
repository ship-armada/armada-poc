// ABOUTME: Timing constants and mask helpers for the BalanceScrambleValue scramble/settle animation.
// ABOUTME: Ported from the armada-app design mockup.
/** Per-character scramble window before settling. */
export const BALANCE_SCRAMBLE_MS = 420

/** Odometer / bullet settle duration after scramble. */
export const BALANCE_SCRAMBLE_SETTLE_MS = 320

/** Stagger between characters (left → right). */
export const BALANCE_SCRAMBLE_STAGGER_MS = 30

/** Interval between random spin ticks during scramble. */
export const BALANCE_SCRAMBLE_TICK_MS = 42

export const BALANCE_MASK_CHAR = '•'

/** Characters cycled through during the scramble phase. */
export const BALANCE_SCRAMBLE_POOL = '0123456789•,.'

export function maskBalanceValue(value: string): string {
  return value.replace(/./g, BALANCE_MASK_CHAR)
}

/** Upper bound for a full hide/reveal transition (used for cleanup timers). */
export function balanceScrambleMaxDurationMs(charCount: number): number {
  const stagger = Math.max(0, charCount - 1) * BALANCE_SCRAMBLE_STAGGER_MS
  return stagger + BALANCE_SCRAMBLE_MS + BALANCE_SCRAMBLE_SETTLE_MS + 100
}
