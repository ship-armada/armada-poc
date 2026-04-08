# Governance Activation: Crowdfund → Treasury → Governance

How Armada's crowdfund, treasury, and governance systems connect and activate.

## Treasury as the Unified Fund Destination

The `ArmadaTreasuryGov` is the protocol treasury — not a governance subsystem. Governance controls it (via timelock), but conceptually the treasury exists independently as the destination for all protocol funds:

| Source | Asset | Flow |
|--------|-------|------|
| Crowdfund sale proceeds | USDC | `crowdfund.withdrawProceeds()` → treasury |
| Crowdfund unallocated ARM | ARM | `crowdfund.withdrawUnallocatedArm()` → treasury |
| Protocol fee capture (future) | USDC | Shielded pool fees → treasury |
| ARM reserves | ARM | Managed by governance proposals |

The crowdfund contract stores the treasury address as an immutable — it cannot be changed after deployment.

## ARM Token Distribution

A single `ArmadaToken` is deployed with a fixed 12M supply (`INITIAL_SUPPLY = 12_000_000e18`). No mint or burn. Distribution:

| Destination | Amount | Purpose |
|-------------|--------|---------|
| Treasury | 7.8M (configurable) | Protocol reserves, governed by proposals |
| Crowdfund contract | 1.8M (configurable) | Backs MAX_SALE at $1/ARM |
| RevenueLock | 2.4M (configurable) | Revenue-gated release to beneficiaries |
| Deployer remainder | 0 | All ARM allocated at deployment |

These values are configured in `config/networks.ts` under `armDistribution` and can be overridden via environment variables (`ARM_TREASURY_ALLOCATION`, `ARM_CROWDFUND_ALLOCATION`). The deployer retains whatever ARM remains after the treasury, crowdfund, and RevenueLock allocations.

**Production numbers are TBD.** The POC defaults are chosen to exercise the system mechanics, not to represent final tokenomics.

## Deployment Order

Contracts must deploy in this order. Each step depends on artifacts from previous steps.

```
1. Governance stack
   └─ TimelockController
   └─ ArmadaToken (canonical, 12M supply, ERC20Votes)
   └─ ArmadaTreasuryGov
   └─ ArmadaGovernor
   └─ Transfer treasury ARM allocation from deployer

2. Crowdfund
   └─ Read governance manifest → get armToken, treasury, governor addresses
   └─ Deploy ArmadaCrowdfund(usdc, armToken, admin, treasury)
   └─ Transfer crowdfund ARM allocation from deployer
   └─ governor.setExcludedAddresses([crowdfundAddress])
```

The `deploy_crowdfund.ts` script hard-fails if the governance deployment manifest is missing.

### Why `setExcludedAddresses` Matters

The governor's `quorum()` function calculates eligible supply as:

```
eligibleSupply = totalSupply - treasuryBalance - sum(excludedBalances)
```

Without excluding the crowdfund contract, its 1.8M ARM balance would count toward the quorum denominator even though no one can vote with those tokens (they're locked in the contract until claimed). This would inflate quorum requirements, making governance harder to activate.

The `setExcludedAddresses` call is a **one-time** operation gated by the deployer address. Once called, the excluded list is locked and cannot be changed. This prevents the deployer from manipulating quorum calculations post-deployment.

## Activation Sequence

After deployment, governance activates through the crowdfund lifecycle:

```
1. SETUP        Admin adds seed addresses
2. INVITATION   Seeds invite hop-1, hop-1 invites hop-2 (2-week window)
3. COMMITMENT   All whitelisted addresses commit USDC (1-week window)
4. FINALIZE     Admin calls finalize() → pro-rata allocation calculated
5. CLAIM        Participants call claim() → receive ARM + USDC refund

── governance becomes usable ──

6. DELEGATE     ARM holders self-delegate (or delegate to a representative)
7. PROPOSE      Delegated holders above threshold (0.1% of supply) create proposals
8. VOTE         Delegated holders vote during voting period
9. QUEUE        Passing proposals are queued in timelock
10. EXECUTE     After timelock delay, proposals execute
```

### Quorum Math

As participants claim ARM from the crowdfund and delegate it, the quorum denominator shifts:

- **Before any claims:** Eligible supply is small (only ARM held by deployer and any pre-distributed tokens). The crowdfund balance is excluded.
- **After claims:** Claimed ARM enters circulation. When delegated, it becomes active voting power.
- **Quorum thresholds:** Each proposal type has its own quorum BPS (e.g., 20% for standard proposals). The quorum is calculated against eligible supply at the proposal's snapshot block.

Example with POC defaults:
- Total supply: 12M ARM
- Treasury: 7.8M (excluded from quorum via `treasuryAddress`)
- Crowdfund: 1.8M (excluded via `setExcludedAddresses`)
- RevenueLock: 2.4M (excluded via `setExcludedAddresses`)
- Eligible supply: whatever ARM has been claimed from crowdfund and is in circulation
- If 1.8M ARM is fully claimed and delegated, quorum for a 20% proposal = 360K ARM

## Key Constraints

- **Immutable admin:** The crowdfund's `admin` is set at deployment and cannot be changed. For production, an admin transfer function should be added so governance (timelock) can take over post-sale duties. Tracked as a Codeberg issue.
- **Immutable treasury:** The crowdfund's treasury destination cannot be redirected after deployment. This is intentional — it prevents admin from diverting funds.
- **One-time quorum exclusion:** The governor's excluded addresses list locks after the first `setExcludedAddresses` call. Future crowdfund rounds would need to be included in the initial call or require a governance proposal to add a new exclusion mechanism.
- **Fixed ARM supply:** 12M total, no mint/burn. All distribution decisions are final once tokens are transferred.
- **Proposal threshold:** 0.1% of total supply = 12,000 ARM. This is absolute (not based on eligible supply), ensuring a minimum skin-in-the-game regardless of distribution.

## Future: Protocol Fee Capture

When the shielded pool is in production, protocol fees (charged on shield/transact operations) will flow to the treasury. This completes the revenue cycle:

```
Users → Shielded Pool (fees) → Treasury ← Governance proposals
                                  ↑
                          Crowdfund proceeds
```

The treasury contract already supports receiving arbitrary ERC20 transfers. Governance proposals can then allocate treasury funds (ARM or USDC) for protocol development, grants, buybacks, or other purposes via timelock-gated execution.
