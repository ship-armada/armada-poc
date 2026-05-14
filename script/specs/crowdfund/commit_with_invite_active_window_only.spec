// Every successful commitWithInvite() runs inside the active window: phase ==
// Active AND windowStart <= timestamp < windowEnd. Mirror of
// commit_active_window_only.spec for the signed-invite path.
//
// Phase enum: Active=0, Finalized=1, Canceled=2.

vars: ArmadaCrowdfund cf
inv: cf.phase() == 0 && timestamp >= cf.windowStart() && timestamp < cf.windowEnd() over cf.commitWithInvite
