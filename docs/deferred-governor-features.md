# Deferred Governor Features

Features removed before audit to reduce scope. All are designed for
reimplementation via UUPS upgrade post-audit.

Git reference: `pre-audit-scope-reduction` tag contains the full implementation.

## 1. Proposal Bonds

**What it does:** Requires 1,000 ARM bond when creating Standard/Extended
proposals (only when ARM is transferable). Bond is always returned but with
graduated lock periods: 0 days (success/self-cancel/expired), 15 days
(quorum failure), 45 days (voted down). Vetoed proposals defer bond claim
until ratification resolves.

**Why removed:** Bonds add a state machine that must reason about every
terminal proposal state, including the veto-ratification linkage. Auditor
cost is disproportionate to LOC. Pre-transfer-unlock, the proposal threshold
(1,000 ARM) already prevents spam.

**Key design parameters to preserve:**
- PROPOSAL_BOND = 1,000 ARM (1_000 * 1e18)
- BOND_LOCK_QUORUM_FAIL = 15 days
- BOND_LOCK_VOTE_FAIL = 45 days
- Bond only required when armToken.transferable() is true
- No bond for Steward or VetoRatification proposals
- Vetoed proposal bonds deferred until ratification executes

**Storage:** BondInfo struct + proposalBonds mapping.

**Reimplementation:** Add new state variables at END of storage layout
(after all current variables). Do NOT reinsert at old positions. The
claimBond() function reads proposal terminal state — ensure state()
returns are still compatible. Restore tests from:
- test-foundry/GovernorClassificationBondWindDown.t.sol (bond section)
- test-foundry/GovernorVeto.t.sol (bond-integration section)
- test/governance_veto.ts (Bond Deferral describe block)
- test/governance_adversarial.ts (expired bond test)

## 2. Steward Circuit Breaker

**What it does:** Auto-pauses the steward spending channel after 5
consecutive steward proposals with <30% voter participation. Uses a
cursor-based auto-resolution pattern: each proposeStewardSpend() call
lazily resolves prior completed proposals. Governance (timelock) can
resume the channel.

**Why removed:** The cursor-based iteration and participation tracking
add ~65 LOC with non-trivial control flow that auditors must trace
through every proposeStewardSpend() call. Steward budget caps in
TreasuryGov already limit blast radius.

**Key design parameters to preserve:**
- CIRCUIT_BREAKER_THRESHOLD = 5 consecutive low-participation proposals
- CIRCUIT_BREAKER_PARTICIPATION_BPS = 3000 (30%)
- Participation = (forVotes + againstVotes + abstainVotes) / snapshotEligibleSupply
- Counter resets to 0 on any proposal meeting threshold
- Only timelock can resume (resumeStewardChannel)

**Storage:** consecutiveLowParticipationCount (uint256),
stewardChannelPaused (bool), stewardProposalResolved (mapping),
_stewardProposalIds (uint256[]), _stewardResolveIndex (uint256).

**Reimplementation:** Add new state variables at END of storage layout.
The circuit breaker integrates at 3 points in proposeStewardSpend():
(1) call _autoResolveStewardProposals(), (2) check stewardChannelPaused,
(3) push to _stewardProposalIds. Restore tests from:
- test-foundry/GovernorCircuitBreaker.t.sol (entire file)

## 3. GovernorStringLib

**What it does:** External library (uint2str, bytes32ToHex) used to
build human-readable description strings for veto ratification proposals.
Deployed as a separate contract and linked via DELEGATECALL.

**Why removed:** 37 LOC + a separate deployment. The proposal ID and
rationale hash are already queryable on-chain via ratificationOf mapping
and ProposalVetoed event. Description is purely informational.

**Reimplementation:** Re-create GovernorStringLib.sol, deploy it, and
link it in the governor factory call. Update _createRatificationProposal()
to use the string-building expression. Update deploy scripts and test
helpers to deploy + link the library. Restore from git tag.

## Storage Layout Safety

This contract is UUPS-upgradeable. When reimplementing any of these
features via upgrade, NEW state variables MUST be appended at the end
of the storage layout. Never reinsert variables at positions occupied
by other variables in the audited version. Constants and immutables
do not affect storage layout.
