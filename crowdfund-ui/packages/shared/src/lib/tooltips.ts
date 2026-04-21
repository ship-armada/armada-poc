// ABOUTME: Shared glossary text for info-icon tooltips on domain terms.
// ABOUTME: Single source; update here, all call sites follow.

export const TOOLTIPS = {
  hop: 'Social distance from the initial whitelist (hop 0 = whitelisted, hop 1 = invited by hop 0, hop 2 = invited by hop 1).',
  slot: 'Each participant has a finite number of invite slots they can pass on to invitees.',
  proRata: 'If a hop is oversubscribed, commitments scale down proportionally.',
  allocation: 'Your projected ARM governance token share based on current commitments.',
  delegate: 'The address authorized to vote your ARM governance tokens on your behalf.',
} as const

export type TooltipKey = keyof typeof TOOLTIPS
