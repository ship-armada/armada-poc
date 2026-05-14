// Every successful commit() observes the active-window preconditions in its
// pre-state: phase == Active AND windowStart <= timestamp < windowEnd.
// windowStart and windowEnd are immutable, so a bare reference is exact.
//
// Phase enum: Active=0, Finalized=1, Canceled=2.
// V exposes block.timestamp as the bare keyword `timestamp`.

vars: ArmadaCrowdfund cf
inv: old(cf.phase()) == 0 && old(timestamp) >= cf.windowStart() && old(timestamp) < cf.windowEnd() over cf.commit
