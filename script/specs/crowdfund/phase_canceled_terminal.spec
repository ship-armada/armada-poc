// Phase.Canceled is terminal: once the Security Council cancels the sale,
// no subsequent call may move phase out of Canceled.
//
// Phase enum: Active=0, Finalized=1, Canceled=2.

vars: ArmadaCrowdfund cf
inv: !(old(cf.phase()) == 2 && cf.phase() != 2) over cf.*
