// claimed[u] is one-way: once an address has claimed (success path or refund
// path), the flag never reverts to false. Catches any future refactor that
// might accidentally clear it and enable a double-claim.

vars: ArmadaCrowdfund cf, address u
inv: !(old(cf.claimed(u)) && !cf.claimed(u)) over cf.*
