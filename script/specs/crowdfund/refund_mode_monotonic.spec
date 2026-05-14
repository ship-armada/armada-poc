// refundMode is one-way: once finalize() enters refund mode (capped demand
// below MIN_SALE, or post-allocation USDC < MIN_SALE), it stays in refund
// mode for the rest of the contract's life.

vars: ArmadaCrowdfund cf
inv: !(old(cf.refundMode()) && !cf.refundMode()) over cf.*
