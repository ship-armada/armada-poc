# Reserve integration decisions

## 2026-09-18 — Irrevocable reserve and sponsored payouts

Status: **Converged for implementation**. This records the decisions for PR #529;
it does not replace unrelated project strategy records or the published cap table.

- **Custody:** the existing RevenueLock holds 20% of total ARM supply for team,
  advisors, airdrop and reserve combined. The new distributor is a constructor-set
  beneficiary for approximately 3% of total supply; approximately 17% goes directly
  to initial beneficiaries. The reserve is not assumed to come exclusively from
  the team's category. Exact direct allocations plus reserve must sum to the 20%.
- **Authority:** a fixed, existing 2-of-3 multisig chooses when, whom and how much to
  assign within the reserve. Grants only increase; claims never replenish capacity.
  New grants inherit completed revenue milestones. Multisig owner changes are wallet
  operations and do not change the distributor's fixed allocator address.
- **Payouts:** retain permissionless sponsored batches, now named `distribute()`.
  One caller pays gas for up to 50 grantees plus the allocator. This intentionally
  supersedes the earlier recommendation for beneficiary-initiated claims: small
  grants should not require each recipient to pay gas at every milestone.
- **Governance consequence accepted:** the distributor is quorum-excluded while it
  holds ARM. Any sponsor can move earned grants into eligible supply before recipients
  delegate, including in the block a proposal is created. This may raise the quorum
  requirement without adding votes to that proposal's historical snapshot. Existing
  proposals retain their stored denominator. See GOVERNANCE.md for the bounds.
- **Wind-down:** assignment authority ends when RevenueLock freezes. The unassigned
  remainder becomes the allocator's entitlement automatically. Only its frozen unlocked
  portion is payable; the locked portion stays in RevenueLock. If the allocator is
  team-controlled, describe this conditional team entitlement in crowdfund disclosures.
- **Deployment:** funding is the point of no return. Bind first, finish token
  initialization and wind-down wiring, register quorum exclusions, and run automated
  pre-funding checks. A view helper without a script assertion is insufficient.
- **Scope:** only the reserve uses the distributor. The full-20% wrapper alternative
  is removed from the launch spec. Existing governance Solidity sources stay unchanged.
  The distributor and its deployment integration require their own audit.
- **Arithmetic:** retain OpenZeppelin `Math.mulDiv`; no arithmetic change is needed
  to address this review.

The implementation spec is [REVENUE_RESERVE_DISTRIBUTOR.md](REVENUE_RESERVE_DISTRIBUTOR.md).
