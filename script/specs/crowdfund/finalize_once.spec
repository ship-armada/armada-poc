// finalize() may complete at most once. Once a finalize() call has finished
// (any path — success, capped-demand-below-MIN_SALE refundMode, or
// post-allocation refundMode), every future finalize() call must revert.
//
// Temporal phrasing: at every point where finalize finishes, from the next
// state onwards finalize is permanently reverted.

vars: ArmadaCrowdfund cf
spec: [](finished(cf.finalize()) ==> X [](reverted(cf.finalize())))
