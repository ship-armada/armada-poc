# Shielded Yield

⚠️ Subject to change! Let's discuss ⚠️

## Overview

Armada enables shielded USDC to earn yield from Aave v4 without breaking privacy or incurring fees on the principal. Users can deposit directly into yield positions, lend and redeem between shielded USDC and yield, and pay directly from yield positions. Armada takes a cut of yield only, not deposits.

| Action | Fee |
|--------|-----|
| Shield to Yield (direct) | Armada + integrator (on principal) |
| Lend (USDC → yield) | Zero |
| Redeem (yield → USDC) | 10% of yield |
| Pay from Yield (direct) | 10% of yield |
| Transfer yield position | Zero |

---

## Position Types

Armada's shielded pool contains two position types:

| Position | Token | Behavior | Use Case |
|----------|-------|----------|----------|
| Shielded USDC | USDC | Static value | Payments, short-term holding |
| Shielded Yield | Armada Shares | Claim on yield-bearing vault | Long-term holding, earning yield |

Both are standard ERC-20 tokens from the circuit's perspective. Yield mechanics happen at the vault level, not the circuit level.

---

## Transitions

```
                ┌─────────────────────────────────────────┐
                │           UNSHIELDED WORLD              │
                │                                         │
                │   [USDC]                                │
                │    │ │ ▲                                │
                └────┼─┼─┼────────────────────────────────┘
                     │ │ │
           shield to │ │ │ unshield
               yield │ │ │ + pay from yield
                     │ │ │
                ┌────┼─┼─┼────────────────────────────────┐
                │    │ ▼ │                                │
                │    │[Shielded    lend     [Shielded     │
                │    │ USDC] ─────────────→  Yield]───────┤
                │    │  ▲ │                    │          │
                │    │  │ │      redeem        │          │
                │    │  │ └────────────────────┘          │
                │    │  │                                 │
                │    └──┼─────────────────────────────────┤
                │ shield│                                 │
                │       │        SHIELDED POOL            │
                └───────┼─────────────────────────────────┘
                        │
                      [USDC]
```

### v1 Transition Set

| Action | From | To | Fee |
|--------|------|-----|-----|
| Shield | Unshielded USDC | Shielded USDC | Armada + integrator |
| Shield to Yield | Unshielded USDC | Shielded Yield | Armada + integrator |
| Shield (CCTP) | USDC (other chain) | Shielded USDC | Armada + integrator |
| Shield to Yield (CCTP) | USDC (other chain) | Shielded Yield | Armada + integrator |
| Lend | Shielded USDC | Shielded Yield | Zero |
| Redeem | Shielded Yield | Shielded USDC | 10% of yield |
| Redeem + Unshield | Shielded Yield | Unshielded USDC | 10% of yield |
| Redeem + Unshield (CCTP) | Shielded Yield | USDC (other chain) | 10% of yield |
| Transfer | Shielded USDC | Shielded USDC | Zero |
| Transfer | Shielded Yield | Shielded Yield | Zero |
| Unshield | Shielded USDC | Unshielded USDC | Zero |
| Unshield (CCTP) | Shielded USDC | USDC (other chain) | Zero |

### User Flows

**Deposit directly to yield:**
```
USDC (Arbitrum) → shield to yield via CCTP → Shielded Yield
```

**Pay directly from yield:**
```
Shielded Yield → redeem + unshield via CCTP → Recipient (Base)
```

**Deposit, earn, then pay:**
```
USDC → shield → Shielded USDC → lend → Shielded Yield
  ... time passes ...
Shielded Yield → redeem → Shielded USDC → unshield → Recipient
```

**Send yield position to friend:**
```
Shielded Yield → transfer → Friend's Shielded Yield
```

**Exit everything:**
```
Shielded Yield → redeem + unshield → USDC
```

---

## Architecture

### ArmadaYieldVault

An ERC-4626 vault that wraps Aave v4's USDC vault.

```
User USDC → ArmadaYieldVault → Aave v4 Vault → Lending Pool
                ↓
         Armada Shares (non-rebasing)
```

**Key properties:**
- Issues non-rebasing shares (compatible with shielded notes)
- Tracks total principal deposited
- Applies yield fee on redemption
- Privileged shield/unshield path (zero protocol fee)

### Why Non-Rebasing Shares

Aave v4 uses ERC-4626 share accounting—share balances stay constant while share price increases. This is essential for compatibility with shielded notes, which commit to fixed token amounts.

```
Time 0: User lends 1000 USDC → receives 1000 shares @ $1.00
Time 1: Aave generates 6% yield → 1000 shares now worth $1060
        User's note still says "1000 shares" (correct)
```

---

## Entry Operations

### Shield (Standard)

Unshielded USDC → Shielded USDC.

```solidity
function shield(
    uint256 amount,
    bytes calldata npk,
    address integrator
) external {
    USDC.transferFrom(msg.sender, address(this), amount);
    
    uint256 fee = calculateFee(amount, integrator);
    uint256 netAmount = amount - fee;
    distributeFee(fee, integrator);
    
    railgun.shield(USDC, netAmount, npk);
}
```

### Shield to Yield (Direct)

Unshielded USDC → Shielded Yield in one step.

```solidity
function shieldToYield(
    uint256 amount,
    bytes calldata npk,
    address integrator
) external {
    USDC.transferFrom(msg.sender, address(this), amount);
    
    // Same fee as regular shield
    uint256 fee = calculateFee(amount, integrator);
    uint256 netAmount = amount - fee;
    distributeFee(fee, integrator);
    
    // Deposit to yield vault
    USDC.approve(address(yieldVault), netAmount);
    uint256 shares = yieldVault.deposit(netAmount, address(this));
    
    // Shield the shares
    railgun.shield(SHARE_TOKEN, shares, npk);
}
```

### Shield via CCTP

Both standard shield and shield-to-yield support CCTP for cross-chain deposits:

```solidity
// In ArmadaCCTPReceiver
function completeShield(
    bytes32 depositId,
    bytes calldata npk,
    bool toYield,
    bytes calldata proof
) external {
    PendingDeposit storage dep = pendingDeposits[depositId];
    
    uint256 fee = calculateFee(dep.amount, dep.integrator);
    uint256 netAmount = dep.amount - fee;
    distributeFee(fee, dep.integrator);
    
    if (toYield) {
        USDC.approve(address(yieldVault), netAmount);
        uint256 shares = yieldVault.deposit(netAmount, address(this));
        railgun.shield(SHARE_TOKEN, shares, npk);
    } else {
        railgun.shield(USDC, netAmount, npk);
    }
}
```

---

## Internal Operations

### Lend

Convert shielded USDC to shielded yield position. Zero fee.

```
User has shielded USDC note (1000 USDC)

1. User generates proof: "I own 1000 USDC"
2. Relayer executes atomic transaction:
   a. Unshield 1000 USDC to adapter (zero fee)
   b. Adapter deposits to vault
   c. Shield shares to user's new address (zero fee)

User now has shielded yield note (1000 shares)
```

```solidity
function lend(
    bytes calldata unshieldProof,
    uint256 amount,
    bytes calldata npk
) external onlyRelayer {
    railgun.unshieldTo(unshieldProof, USDC, amount, address(this));
    
    USDC.approve(address(yieldVault), amount);
    uint256 shares = yieldVault.deposit(amount, address(this));
    
    railgun.shield(SHARE_TOKEN, shares, npk);
    
    emit Lend(amount, shares);
}
```

### Redeem

Convert shielded yield position to shielded USDC. 10% yield fee.

```
User has shielded yield note (1000 shares)
Shares now worth $1.06 each (6% yield accrued)

1. User generates proof: "I own 1000 shares"
2. Relayer executes atomic transaction:
   a. Unshield 1000 shares to adapter (zero fee)
   b. Adapter redeems from vault → 1060 USDC
   c. Vault calculates yield fee: 6 USDC → treasury
   d. Shield 1054 USDC to user (zero fee)

User now has shielded USDC note (1054 USDC)
```

```solidity
function redeem(
    bytes calldata unshieldProof,
    uint256 shares,
    bytes calldata npk
) external onlyRelayer {
    railgun.unshieldTo(unshieldProof, SHARE_TOKEN, shares, address(this));
    
    // Yield fee applied internally by vault
    uint256 usdc = yieldVault.redeem(shares, address(this), address(this));
    
    railgun.shield(USDC, usdc, npk);
    
    emit Redeem(shares, usdc);
}
```

---

## Exit Operations

### Unshield (Standard)

Shielded USDC → Unshielded USDC. Zero fee.

Standard Railgun unshield operation.

### Redeem + Unshield (Direct Payment from Yield)

Shielded Yield → Unshielded USDC in one step. 10% yield fee.

```solidity
function redeemAndUnshield(
    bytes calldata unshieldProof,
    uint256 shares,
    address recipient
) external onlyRelayer {
    railgun.unshieldTo(unshieldProof, SHARE_TOKEN, shares, address(this));
    
    // Yield fee applied internally by vault
    uint256 usdc = yieldVault.redeem(shares, address(this), address(this));
    
    USDC.transfer(recipient, usdc);
    
    emit RedeemAndUnshield(shares, usdc, recipient);
}
```

### Redeem + Unshield via CCTP (Cross-Chain Payment from Yield)

Shielded Yield → USDC on another chain in one step. 10% yield fee.

```solidity
function redeemAndUnshieldCCTP(
    bytes calldata unshieldProof,
    uint256 shares,
    uint32 destChain,
    bytes32 recipient
) external onlyRelayer {
    railgun.unshieldTo(unshieldProof, SHARE_TOKEN, shares, address(this));
    
    // Yield fee applied internally by vault
    uint256 usdc = yieldVault.redeem(shares, address(this), address(this));
    
    // Burn via CCTP
    USDC.approve(address(cctpMessenger), usdc);
    cctpMessenger.depositForBurn(usdc, destChain, recipient, address(USDC));
    
    emit RedeemAndUnshieldCCTP(shares, usdc, destChain, recipient);
}
```

---

## Yield Accounting

### Principal Tracking

The vault tracks deposits to calculate yield at redemption:

```solidity
contract ArmadaYieldVault is ERC4626 {
    IERC4626 public aaveVault;
    uint256 public constant YIELD_FEE_BPS = 1000; // 10%
    
    uint256 public totalPrincipal;
    
    function deposit(uint256 assets, address receiver) public override returns (uint256 shares) {
        totalPrincipal += assets;
        
        USDC.approve(address(aaveVault), assets);
        uint256 aaveShares = aaveVault.deposit(assets, address(this));
        
        shares = aaveShares;
        _mint(receiver, shares);
    }
    
    function redeem(uint256 shares, address receiver, address owner) public override returns (uint256 assets) {
        _burn(owner, shares);
        
        uint256 principalPortion = (shares * totalPrincipal) / totalSupply();
        totalPrincipal -= principalPortion;
        
        assets = aaveVault.redeem(shares, address(this), address(this));
        
        if (assets > principalPortion) {
            uint256 yield = assets - principalPortion;
            uint256 fee = (yield * YIELD_FEE_BPS) / 10000;
            USDC.transfer(treasury, fee);
            assets -= fee;
        }
        
        USDC.transfer(receiver, assets);
    }
}
```

### Example

```
Deposit:
  User deposits 1000 USDC
  totalPrincipal: 0 → 1000
  User receives: 1000 shares

Time passes, Aave generates 6% yield...

Redeem:
  User redeems 1000 shares
  Aave returns: 1060 USDC
  Principal portion: 1000 USDC
  Yield: 60 USDC
  Armada fee (10%): 6 USDC → treasury
  User receives: 1054 USDC
  totalPrincipal: 1000 → 0
```

---

## Zero-Fee Path

### Privileged Access

Internal operations (lend, redeem) use a privileged path that bypasses shield/unshield fees:

```solidity
function isPrivilegedCaller(address caller) internal view returns (bool) {
    return caller == ARMADA_YIELD_ADAPTER;
}
```

**Why this is safe:**
- Users pay entry fee when first shielding (either to USDC or directly to yield)
- Armada captures value from yield (10%), not from internal churn
- Adapter contract is immutable and audited

---

## Privacy Model

### What Observers See

**Shield to yield:**
```
USDC transfer from user
ArmadaYieldVault: Deposit event
Aave v4: Supply event (amount visible)
Armada: Shield event (encrypted)
```

**Lend (internal):**
```
Armada: Unshield event (encrypted)
ArmadaYieldVault: Deposit event
Aave v4: Supply event (amount visible)
Armada: Shield event (encrypted)
```

**Redeem + unshield (payment from yield):**
```
Armada: Unshield event (encrypted)
ArmadaYieldVault: Withdraw event
Aave v4: Withdraw event (amount visible)
USDC: Transfer to treasury (fee)
USDC: Transfer to recipient (payment)
```

### Privacy Properties

| Property | Status |
|----------|--------|
| Entry/exit tx linkable | Yes (funds flow through vault) |
| Amounts in Aave visible | Yes (aggregate pool level) |
| User identity hidden | Yes (relayer submits tx) |
| Individual yield hidden | Yes (mixed with other users) |
| Shielded transfers unlinkable | Yes (new address each time) |

---

## Governance Controls

| Parameter | Default | Governance Action |
|-----------|---------|-------------------|
| Yield fee | 10% (1000 bps) | `setYieldFee(bps)` |
| Yield source | Aave v4 only | Future: `addYieldSource(address)` |
| Privileged adapter | Immutable | Requires migration |

---

## Economics

### User Perspective

| Action | Traditional DeFi | Armada |
|--------|------------------|--------|
| Deposit 1000 USDC to yield | Public tx | 0.5% fee, shielded |
| Earn 6% APY (1 year) | 60 USDC (public) | 54 USDC (private) |
| Pay someone | Public tx + gas | Zero fee, shielded |
| **Privacy** | None | Full |

### Protocol Perspective

Two revenue streams:

```
1. Shield fees (one-time):
   $1M deposits × 0.5% = $5,000

2. Yield fees (recurring):
   $10M in vault × 5% APY × 10% fee = $50,000/year
```

---

## Events

```solidity
event Lend(
    uint256 usdcAmount,
    uint256 sharesMinted
);

event Redeem(
    uint256 sharesBurned,
    uint256 usdcRedeemed
);

event RedeemAndUnshield(
    uint256 sharesBurned,
    uint256 usdcRedeemed,
    address recipient
);

event RedeemAndUnshieldCCTP(
    uint256 sharesBurned,
    uint256 usdcRedeemed,
    uint32 destChain,
    bytes32 recipient
);

event YieldFeeUpdated(
    uint256 oldFeeBps,
    uint256 newFeeBps
);
```

---

## Summary

| Aspect | Design |
|--------|--------|
| Yield source | Aave v4 (ERC-4626) |
| User token | Non-rebasing Armada shares |
| Direct entry to yield | Yes |
| Direct payment from yield | Yes |
| Fee on lend/redeem | Zero (10% of yield on redeem) |
| Fee on transfer | Zero |
| Circuit changes | None required |