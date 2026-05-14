// Every successful commitWithInvite() observes the active-window preconditions
// in its pre-state: phase == Active AND windowStart <= timestamp < windowEnd.
// Mirror of commit_active_window_only.spec for the signed-invite commitment
// path.
//
// Phase enum: Active=0, Finalized=1, Canceled=2.
// V exposes block.timestamp as the bare keyword `timestamp`.

vars: ArmadaCrowdfund cf
inv: old(cf.phase()) == 0 && old(timestamp) >= cf.windowStart() && old(timestamp) < cf.windowEnd() over cf.commitWithInvite
