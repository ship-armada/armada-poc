// armLoaded is one-way: once loadArm() has succeeded and set the flag, no
// subsequent call may unset it. Guards against an accidental refactor that
// re-resets the load gate.

vars: ArmadaCrowdfund cf
inv: !(old(cf.armLoaded()) && !cf.armLoaded()) over cf.*
