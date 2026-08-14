// ABOUTME: Timing constants and helpers for the BalanceCard reveal, digit roll, and action-enter animations.
// ABOUTME: Ported from the armada-app design mockup.
/** Keep in sync with BalanceCard.module.css balance reveal keyframes. */
export const BALANCE_REVEAL_DELAY_MS = 1280
export const BALANCE_REVEAL_DURATION_MS = 920
export const BALANCE_REVEAL_SPLIT_AT = 0.42

/** Digit odometer roll — intentionally longer than the balance reveal split window. */
export const BALANCE_ROLL_DURATION_MS = 1000
export const BALANCE_ROLL_DIGIT_STAGGER_MS = 70

/** Action button enter — keep in sync with BalanceCard.module.css `.actionEnter`. */
export const BALANCE_ACTION_BUTTON_ENTER_MS = 520
export const BALANCE_DEPOSIT_BUTTON_ENTER_DELAY_MS = 630

/** Tooltip appears shortly after the deposit button finishes entering. */
export const DASHBOARD_TOOLTIP_ENTER_DELAY_MS =
  BALANCE_DEPOSIT_BUTTON_ENTER_DELAY_MS + BALANCE_ACTION_BUTTON_ENTER_MS + 180

/** Pause after balance motion before the activity panel enters. */
export const ACTIVITY_REVEAL_BUFFER_MS = 240

export function balanceRevealRollStartMs(): number {
  return BALANCE_REVEAL_DELAY_MS + BALANCE_REVEAL_DURATION_MS * BALANCE_REVEAL_SPLIT_AT
}

export function balanceRevealRollDurationMs(): number {
  return BALANCE_ROLL_DURATION_MS
}

export function activityRevealDelayAfterIntroMs(): number {
  return BALANCE_REVEAL_DELAY_MS + BALANCE_REVEAL_DURATION_MS + ACTIVITY_REVEAL_BUFFER_MS
}

export function activityRevealDelayAfterRollMs(formattedBalance: string): number {
  const digitCount = formattedBalance.replace(/\D/g, '').length
  const stagger = Math.max(0, digitCount - 1) * BALANCE_ROLL_DIGIT_STAGGER_MS
  return BALANCE_ROLL_DURATION_MS + stagger + 80 + ACTIVITY_REVEAL_BUFFER_MS
}
