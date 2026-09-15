// ABOUTME: Locked durations for CrowdfundLeftColumn list open/close sequencing.
// ABOUTME: Must stay in sync with --hero-expand-duration in Hero.module.css.

/**
 * Hero left-column list animation (see CrowdfundLeftColumn).
 * Durations match --hero-expand-duration in Hero.module.css.
 *
 * LOCKED — short viewport (max-height ≤799px), do not change without re-testing filter row:
 * - Open:  card 380ms → list shell 380ms → list content fade 200ms (starts at 760ms)
 * - Close: list fade 200ms → retract 380ms → card re-enter 380ms (filter pinned throughout)
 */
export const CROWDFUND_LIST_EXPAND_MS = 380

/** Participant rows opacity; short close: before retract; short open: after shell expand */
export const CROWDFUND_LIST_CONTENT_FADE_MS = 200
