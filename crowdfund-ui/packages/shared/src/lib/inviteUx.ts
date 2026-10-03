// ABOUTME: Feature flag for the Invite method-picker experiment (single Invite CTA → menu/sheet → action screen).
// ABOUTME: Set to false to restore dual Create link / Invite onchain buttons with inline expand.

/** Rollback: flip to `false` to restore the previous empty-slot dual-CTA UX. */
export const INVITE_METHOD_PICKER_UX = true

export type InviteMethod = 'link' | 'onchain'
