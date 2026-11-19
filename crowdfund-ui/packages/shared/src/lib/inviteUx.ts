// ABOUTME: Feature flag for the Invite method-picker experiment (single Invite CTA → menu/sheet → action screen).
// ABOUTME: Set to false to restore dual Create link / Invite onchain buttons with inline expand.

import { CROWDFUND_FEATURES } from './constants'

/** Rollback: flip to `false` to restore the previous empty-slot dual-CTA UX. */
export const INVITE_METHOD_PICKER_UX = true

export type InviteMethod = 'link' | 'onchain'

/** Whether the active profile offers on-chain invites by address. When false (e.g. the relaunch,
 *  where outside contributors join only through team-wallet links), invites are link-only. */
export const DIRECT_INVITES_ENABLED: boolean = CROWDFUND_FEATURES.directInvites
