# PR #529 legacy Sepolia verification

Read-only recovery on 2026-09-24; no transactions were submitted. This deployment
predates the reserve distributor and has two direct allocations of 100 ARM each.
These testnet amounts do not establish mainnet allocations.

## Constructor provenance

- Chain ID: 11155111.
- RevenueLock: 0x8C0B3464E6250D6ab66e3FC3369fCe169161fc61.
- Creation transaction: 0x681abad1026db36d1b7b336323cf3f0243d35b15b4d8589802dcfd7bc812e8ac.
- Creation block: 11588010; hash 0x5d4f96edb5f7cc7d5853e0ec6ade7cb57f2c100f561dbbdecd92f93132572ca4.
- Deployer: 0x98b1CBa0908C98c95c9C87D94e4fCdddc87C933d; nonce 1264; successful receipt names the expected contract.
- Full creation input keccak256: 0x1687427a8a14e34a735e1e282b0cbcf793aa9e20f8ab7faa1e282f2602bb5b5b.

Decoded the constructor arguments from the creation transaction and backfilled
revenueLockConstructorArgs and revenueLockDeploymentTransaction in
deployments/governance-hub-sepolia.json. Creation bytecode exactly matches the
compiled RevenueLock artifact at PR head 08b825ba. The production
buildRevenueLockVerificationTasks helper validated the recovered arguments against
the live lock and reconstructed the entire original deployment input exactly.
This restores verification input; no explorer submission or verification success is claimed.

## Timelock read-back

At block 11772557 (hash
0xd4e540a5a08b3f95d838dc0f018c76a4bf9292fd511cd32fe74b2f5c80d78b78),
public Sepolia RPC reads confirmed the lock's token, counter, rate, total allocation,
beneficiary count and both allocations match the recovered arguments.
Timelock 0xB1e8381702f934FbdA33D1C916eE72948a6ED406 returned:

| Deployer role / setting | Result |
| --- | --- |
| TIMELOCK_ADMIN_ROLE | Not held |
| PROPOSER_ROLE | Held |
| EXECUTOR_ROLE | Held |
| CANCELLER_ROLE | Held |
| Minimum delay | 60 seconds |

The production timelockBootstrapChecks helper independently reported admin
renunciation as PASS and the three retained roles as FAIL when asked to enforce
hardening. This matches the committed non-hardened Sepolia configuration; it is
not evidence of mainnet readiness. Older DEFAULT_ADMIN_ROLE checks cannot establish
renunciation. Mainnet requires the intended production delay and removal of all
deployer bootstrap roles, verified against the actual deployment.
