// totalCommitted is monotonically non-decreasing across any call. Commits add
// to it; no path decreases it (finalize and refunds don't touch it — they only
// update derived/per-participant state). Catches any future change that would
// "undo" a commit without going through the refund path.

vars: ArmadaCrowdfund cf
inv: old(cf.totalCommitted()) <= cf.totalCommitted() over cf.*
