// ABOUTME: Barrel for the MyPosition family of dashboards plus the shared demo helpers.
// ABOUTME: Re-exports the three layout variants and the named exports from myPositionDemo.

export { MyPosition } from './MyPosition'
export type { MyPositionProps } from './MyPosition'
export { MyPositionHero } from './MyPositionHero'
export { MyPositionSplit } from './MyPositionSplit'
export type { MyPositionSplitProps } from './MyPositionSplit'
export {
  COMMITTED,
  CAP,
  ARM_ALLOCATION,
  FILL_PCT,
  formatUsdcCommitted,
  formatArmAllocation,
  GRAPH_SEED,
  GRAPH_PARTICIPANTS,
  DEMO_WALLET,
  DEMO_WALLET_DISPLAY,
  DEMO_SLOTS,
  DEMO_INVITE_ALLOWANCE,
  countAvailableInviteSlots,
  buildInvitePinnedNodes,
} from './myPositionDemo'
export { InvitesCard, HopAvailableRow } from './InvitesCard'
export type { InvitesCardProps, InvitesCardVariant, HopAvailableRowProps } from './InvitesCard'
export {
  allowanceFromPositions,
  availableForHop,
  hopsWithAllowance,
  type InviteAllowance,
  type InviteeHop,
  type InviteListKind,
} from './inviteModel'
