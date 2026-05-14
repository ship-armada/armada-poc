// Every successful commit() runs inside the active window: phase == Active
// AND windowStart <= timestamp < windowEnd. Phase and timestamp do not mutate
// within commit(), so post-state references are equivalent to pre-state.
// windowStart and windowEnd are immutable.
//
// Phase enum: Active=0, Finalized=1, Canceled=2.

vars: ArmadaCrowdfund cf
inv: cf.phase() == 0 && timestamp >= cf.windowStart() && timestamp < cf.windowEnd() over cf.commit
