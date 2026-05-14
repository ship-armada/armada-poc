// Total ARM transferred to claimants must never exceed total ARM allocated
// during finalization. The headline conservation invariant for the success
// path — protects against any allocation accounting bug that lets the contract
// pay out more ARM than was reserved.

vars: ArmadaCrowdfund cf
inv: cf.totalArmTransferred() <= cf.totalAllocatedArm() over cf.*
