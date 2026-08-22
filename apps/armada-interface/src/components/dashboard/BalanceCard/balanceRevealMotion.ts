// ABOUTME: Timing constants and helpers for the BalanceCard reveal, digit roll, action-enter, and
// ABOUTME: promo-banner handoff animations. Ported from the armada-app design mockup (ba1120a/5c2b3e8).

/** Keep in sync with BalanceCard.module.css `.card` enter. */
export const DASHBOARD_CARD_ENTER_DELAY_MS = 220
export const DASHBOARD_CARD_ENTER_DURATION_MS = 480

/** Intro amount rides with the hero card (not a late second beat). */
export const BALANCE_REVEAL_DELAY_MS = DASHBOARD_CARD_ENTER_DELAY_MS
export const BALANCE_REVEAL_DURATION_MS = DASHBOARD_CARD_ENTER_DURATION_MS
export const BALANCE_REVEAL_SPLIT_AT = 0

/** Digit odometer roll — intentionally longer than the balance reveal split window. */
export const BALANCE_ROLL_DURATION_MS = 1000
export const BALANCE_ROLL_DIGIT_STAGGER_MS = 70

/** Action button enter — keep in sync with BalanceCard.module.css `.actionEnter`. */
export const BALANCE_ACTION_BUTTON_ENTER_MS = 520
export const BALANCE_ACTION_BUTTON_STAGGER_MS = 70
/** First action after the hero card (incl. balance) has landed. */
export const BALANCE_ACTION_BUTTON_FIRST_DELAY_MS =
  DASHBOARD_CARD_ENTER_DELAY_MS + DASHBOARD_CARD_ENTER_DURATION_MS
export const BALANCE_DEPOSIT_BUTTON_ENTER_DELAY_MS = BALANCE_ACTION_BUTTON_FIRST_DELAY_MS
export const BALANCE_ACTION_BUTTON_LAST_DELAY_MS =
  BALANCE_ACTION_BUTTON_FIRST_DELAY_MS + BALANCE_ACTION_BUTTON_STAGGER_MS * 3

/** Banner after the last action button finishes entering. */
export const DASHBOARD_TOOLTIP_ENTER_DELAY_MS =
  BALANCE_ACTION_BUTTON_LAST_DELAY_MS + BALANCE_ACTION_BUTTON_ENTER_MS + 180

/** Keep in sync with Dashboard.module.css `.tooltipEnter` duration. */
export const DASHBOARD_TOOLTIP_ENTER_MS = 360

/** Keep in sync with Dashboard.module.css `.tooltipHandoffEnter` / `.tooltipHandoffExit`. */
export const PROMO_BANNER_HANDOFF_MS = 360

/** Pause after the shield promo collapses before the earn banner grows in. */
export const SHIELD_TO_EARN_PAUSE_MS = 280

/** Keep in sync with BalanceCard.module.css `.vaultPositionEnter`. */
export const VAULT_POSITION_ENTER_DELAY_MS = BALANCE_ACTION_BUTTON_FIRST_DELAY_MS
export const VAULT_POSITION_ENTER_DURATION_MS = 420
export const VAULT_POSITION_ENTER_SETTLE_MS =
  VAULT_POSITION_ENTER_DELAY_MS + VAULT_POSITION_ENTER_DURATION_MS

/** Keep in sync with BalanceCard.module.css `.vaultPositionEnterSync`. */
export const VAULT_POSITION_SYNC_ENTER_MS = 520

/** Keep in sync with BalanceCard.module.css `.vaultPositionExit`. */
export const VAULT_POSITION_EXIT_DURATION_MS = 360

/** Pause after the vault row has finished hiding before the earn banner returns. */
export const VAULT_BANNER_AFTER_EXIT_MS = 560

/** Beat after the earn modal closes so the dashboard can paint before balances roll. */
export const VAULT_WITHDRAW_DASHBOARD_HOLD_MS = 640

/** Pause after balance motion before the activity panel enters. */
export const ACTIVITY_REVEAL_BUFFER_MS = 240

export function balanceRevealRollStartMs(): number {
  return BALANCE_REVEAL_DELAY_MS + BALANCE_REVEAL_DURATION_MS * BALANCE_REVEAL_SPLIT_AT
}

export function balanceRevealRollDurationMs(): number {
  return BALANCE_ROLL_DURATION_MS
}

export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function vaultPositionEnterSettleMs(): number {
  return prefersReducedMotion() ? 0 : VAULT_POSITION_ENTER_SETTLE_MS
}

export function vaultPositionExitDurationMs(): number {
  return prefersReducedMotion() ? 0 : VAULT_POSITION_EXIT_DURATION_MS
}

export function vaultWithdrawDashboardHoldMs(): number {
  return prefersReducedMotion() ? 0 : VAULT_WITHDRAW_DASHBOARD_HOLD_MS
}

export function balanceRollSettleMs(formattedBalance: string): number {
  const digitCount = formattedBalance.replace(/\D/g, '').length
  const stagger = Math.max(0, digitCount - 1) * BALANCE_ROLL_DIGIT_STAGGER_MS
  return BALANCE_ROLL_DURATION_MS + stagger + 80
}

export function vaultBannerAfterDepositMs(formattedBalance: string): number {
  if (prefersReducedMotion()) return 0
  return Math.max(balanceRollSettleMs(formattedBalance), VAULT_POSITION_SYNC_ENTER_MS) + 120
}

export function vaultBannerAfterWithdrawMs(formattedBalance: string): number {
  if (prefersReducedMotion()) return 0
  return (
    balanceRollSettleMs(formattedBalance) +
    VAULT_POSITION_EXIT_DURATION_MS +
    VAULT_BANNER_AFTER_EXIT_MS
  )
}

export function activityRevealDelayAfterIntroMs(): number {
  return (
    BALANCE_ACTION_BUTTON_LAST_DELAY_MS + BALANCE_ACTION_BUTTON_ENTER_MS + ACTIVITY_REVEAL_BUFFER_MS
  )
}

export function activityRevealDelayAfterPromoMs(): number {
  return DASHBOARD_TOOLTIP_ENTER_DELAY_MS + DASHBOARD_TOOLTIP_ENTER_MS + ACTIVITY_REVEAL_BUFFER_MS
}

/** Page-load cascade: hero → actions → banner → activity. Later reveals use 0. */
export function dashboardActivityEnterDelayMs(
  hasPromoBanner: boolean,
  isInitialPaint: boolean,
): number {
  if (!isInitialPaint) return 0
  const afterIntro = activityRevealDelayAfterIntroMs()
  if (!hasPromoBanner) return afterIntro
  return Math.max(afterIntro, activityRevealDelayAfterPromoMs())
}

export function shieldBannerExitSettleMs(): number {
  if (prefersReducedMotion()) return 0
  return PROMO_BANNER_HANDOFF_MS + SHIELD_TO_EARN_PAUSE_MS
}

export function activityRevealDelayAfterFirstShieldMs(formattedBalance: string): number {
  if (prefersReducedMotion()) return 80
  return (
    vaultBannerAfterDepositMs(formattedBalance) +
    shieldBannerExitSettleMs() +
    PROMO_BANNER_HANDOFF_MS +
    ACTIVITY_REVEAL_BUFFER_MS
  )
}

/** After a vault deposit: wait for the earn banner to collapse, then reveal the new activity row. */
export function activityRevealDelayAfterVaultDepositMs(formattedBalance: string): number {
  if (prefersReducedMotion()) return 80
  return (
    vaultBannerAfterDepositMs(formattedBalance) +
    PROMO_BANNER_HANDOFF_MS +
    ACTIVITY_REVEAL_BUFFER_MS
  )
}

export function activityRevealDelayAfterRollMs(formattedBalance: string): number {
  return balanceRollSettleMs(formattedBalance) + ACTIVITY_REVEAL_BUFFER_MS
}
