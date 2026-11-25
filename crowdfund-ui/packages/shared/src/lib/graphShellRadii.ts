// ABOUTME: NodeSphere layout geometry: how far from the centre each hop's nodes sit, and the default camera distance.
// ABOUTME: Profiles that hide team wallets drop the always-empty hop-1 shell so the visible tiers stay evenly spaced.

import { CROWDFUND_FEATURES } from './constants.js'

export type GraphShellKind = 'Hop 0' | 'Hop 1' | 'Hop 2' | 'Multi-hop'

/** The designer's four-shell layout. */
const STANDARD_SHELLS: Record<GraphShellKind, number> = {
  'Hop 0': 2.4,
  'Hop 1': 3.6,
  'Hop 2': 5.1,
  'Multi-hop': 6.4,
}

/** With team wallets hidden, no node is ever drawn on the hop-1 shell, so hop 2 and multi-hop each
 *  move in one shell and the visible tiers keep the standard spacing. The hop-1 radius is kept for
 *  completeness; nothing is placed there on these profiles. */
const HIDDEN_TEAM_WALLET_SHELLS: Record<GraphShellKind, number> = {
  'Hop 0': 2.4,
  'Hop 1': 3.6,
  'Hop 2': 3.6,
  'Multi-hop': 5.1,
}

export function graphShellRadii(
  hideTeamWallets: boolean = CROWDFUND_FEATURES.hideTeamWallets,
): Record<GraphShellKind, number> {
  return hideTeamWallets ? HIDDEN_TEAM_WALLET_SHELLS : STANDARD_SHELLS
}

/** How much further out than the closest zoom the camera starts when team wallets are hidden. */
const HIDDEN_TEAM_WALLET_ZOOM_OUT = 0.5

/** The unfocused camera distance. Standard profiles start at the closest zoom (`zMin`); profiles
 *  that hide team wallets start slightly further out. Wheel zoom stays bounded by `zMin` either way. */
export function graphDefaultCameraZ(
  zMin: number,
  hideTeamWallets: boolean = CROWDFUND_FEATURES.hideTeamWallets,
): number {
  return hideTeamWallets ? zMin + HIDDEN_TEAM_WALLET_ZOOM_OUT : zMin
}
