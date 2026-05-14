// Every successful commit() observes the active-window preconditions in its
// pre-state: phase == Active AND windowStart <= block.timestamp < windowEnd.
// windowStart and windowEnd are immutable, so a bare reference is exact.
//
// Phase enum: Active=0, Finalized=1, Canceled=2.

vars: ArmadaCrowdfund cf
inv: old(cf.phase()) == 0
     && old(block.timestamp) >= cf.windowStart()
     && old(block.timestamp) < cf.windowEnd()
     over cf.commit
