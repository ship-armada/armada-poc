# Fee Structure
Subject to change! Let's discuss 👋

## Overview

Armada charges fees **only at shield (deposit)**. All operations inside the shielded pool are either free or minimal.

| Action | Fee |
|--------|-----|
| Shield (deposit) | Armada take + Integrator fee |
| Shielded transfer | Free |
| Shielded swap | Free or minimal |
| Shielded lend | Free |
| Unshield (withdraw) | Free |
| Yield redemption | 15% of yield |

---

## Shield Fee Components

Users pay two independent fees when shielding:

```
Total user fee = Armada take + Integrator fee
```

### Armada Take

Protocol fee that goes to treasury. Decreases as integrators drive volume.

| Integrator Volume | Armada Take |
|-------------------|-------------|
| $0 - $250k | 50 bps (0.50%) |
| $250k+ | 40 bps (0.40%) |

Governance can add additional tiers later.

### Integrator Fee

Fee set by integrator + bonus from Armada take reduction.

```
Integrator fee = Base fee (self-set) + Bonus (from tier)
```

| Integrator Volume | Integrator Bonus |
|-------------------|------------------|
| $0 - $250k | 0 bps |
| $250k+ | 10 bps (0.10%) |

---

## How It Works

### New Integrator (0% base fee)

1. Integrator registers, sets base fee to 0 bps
2. Users pay 50 bps total (all to Armada)
3. Integrator reaches $250k volume
4. Armada take drops to 40 bps, integrator gets 10 bps bonus
5. Users still pay 50 bps (40 to Armada, 10 to integrator)
6. Integrator can lower their fee â†’ users pay less
7. Or integrator keeps 10 bps â†’ earns revenue

### Premium Integrator (with base fee)

1. Integrator sets 20 bps base fee for premium features
2. At $0 volume: users pay 70 bps (50 Armada + 20 integrator)
3. At $250k+: users pay 70 bps (40 Armada + 30 integrator)

User cost stays constant. As Armada's share decreases, integrator captures more.

### Direct Shield (no integrator)

Users who shield directly without an integrator pay base Armada take only (50 bps).

---

## Integrator Registration

Integrators register by calling `setIntegratorFee(bps)` with their desired base fee.

```solidity
// Set base fee (can be 0)
function setIntegratorFee(uint256 feeBps) external {
    integratorBaseFee[msg.sender] = feeBps;
}
```

No approval required. No stake required. Permissionless.

Volume accumulates automatically when users shield with integrator's address as referrer.

---

## Governance Controls

Governance can adjust:

| Parameter | Default | Governance Action |
|-----------|---------|-------------------|
| Base Armada take | 50 bps | `setBaseArmadaTake(bps)` |
| Volume threshold | $250k | `setTier(index, threshold, takeBps)` |
| Armada take after threshold | 40 bps | `setTier(index, threshold, takeBps)` |
| Yield fee | 15% | `setYieldFee(pct)` |

Governance can add additional tiers via `addTier(threshold, takeBps)`.

### Custom Integrator Terms

Governance can grant specific integrators custom terms:

```solidity
setIntegratorTerms(
    address integrator,
    uint256 customArmadaTakeBps,
    uint256 customVolumeThreshold,
    bool hasCustomTerms
)
```

Use cases:
- Strategic partnerships (reduced Armada take for integrator's users)
- Ecosystem grants (waived volume threshold)
- Promotional periods

---

## On-Chain Queries

```solidity
// Integrator stats
function getIntegratorVolume(address integrator) external view returns (uint256);
function getIntegratorEarnings(address integrator) external view returns (uint256);
function getIntegratorBaseFee(address integrator) external view returns (uint256);
function getIntegratorBonus(address integrator) external view returns (uint256);
function getIntegratorTotalFee(address integrator) external view returns (uint256);

// Fee calculation
function getArmadaTake(address integrator) external view returns (uint256);
function getUserFee(address integrator) external view returns (uint256);
```

---

## Events

```solidity
event Shield(
    address indexed asset,
    uint256 amount,
    address indexed integrator,
    uint256 integratorCumulativeVolume,
    uint256 armadaTakeBps,
    uint256 integratorFeeEarned
);

event IntegratorFeeUpdated(
    address indexed integrator,
    uint256 newFeeBps
);

event TierUpdated(
    uint256 indexed tierIndex,
    uint256 volumeThreshold,
    uint256 armadaTakeBps
);
```

---

## Yield Fee

Separate from shield fees. Charged when users redeem yield from the Aave integration.

| Parameter | Value |
|-----------|-------|
| Yield fee | 15% of yield earned |
| Recipient | Treasury |
| Governance | Adjustable |

Example: User earns $100 in yield. At redemption, $15 goes to treasury, $85 to user.

---

## Relayer Fees

Relayers operate independently from protocol fees.

| Aspect | Design |
|--------|--------|
| Who sets | Each relayer sets their own fee |
| Structure | Gas cost + markup (typically ~10% of gas) |
| Payment | Deducted from user's shielded balance |
| Protocol cut | None |

Users can self-relay (pay their own gas) to avoid relayer fees, trading privacy for cost savings.

---

## Summary

| Fee Type | Rate | Recipient | When |
|----------|------|-----------|------|
| Armada take | 40-50 bps (volume tiered) | Treasury | At shield |
| Integrator fee | 0+ bps (integrator-set) + bonus | Integrator | At shield |
| Yield fee | 15% of yield | Treasury | At redemption |
| Relayer fee | Market rate | Relayer | Per transaction |
