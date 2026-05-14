// Phase.Finalized is terminal: once the crowdfund has been finalized (either
// successfully or into refundMode), no subsequent call may reset phase.
//
// Phase enum: Active=0, Finalized=1, Canceled=2.

vars: ArmadaCrowdfund cf
inv: !(old(cf.phase()) == 1 && cf.phase() != 1) over cf.*
