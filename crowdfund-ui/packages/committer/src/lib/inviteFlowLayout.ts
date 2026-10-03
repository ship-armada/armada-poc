// ABOUTME: Decides which /invite flow steps outgrow the fixed 480×500 inline box (InviteLinkFlowInline.module.css).
// ABOUTME: Those steps get the grow + scroll override so their content — and CTA — isn't clipped.

/**
 * True for steps that can be taller than the 480×500 footprint: the post-commit
 * invite-slots list, and the commit / confirmation steps when the Max out banner
 * is hoisted above their 500px card.
 */
export function inviteStepNeedsRoom(step: string, hasMaxOutBanner: boolean): boolean {
  if (step === 'invites') return true
  return hasMaxOutBanner && (step === 'commit' || step === 'confirmation')
}
