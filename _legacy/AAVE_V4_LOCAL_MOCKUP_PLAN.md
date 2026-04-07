# Aave V4 Mock for Local Devnet

## Overview

A simplified Aave V4 Spoke mock that:
- Implements the **exact same interface** as real Aave V4 (`ISpokeBase`)
- Enables frontends to switch between mock and real Aave with **zero code changes**
- Mints yield on-demand using MockUSDCV2 (no seeding required)
- Uses the same RAY precision (27 decimals) as real Aave

---

## Why Mock Instead of Real Aave V4?

After analyzing Aave V4's constraints:

| Constraint | Real Aave | Mock | Impact on POC |
|------------|-----------|------|---------------|
| Yield source | Requires borrowers | Configurable APY | Mock is simpler |
| Build system | Foundry only | Hardhat | Mock fits existing infra |
| Contract count | 7+ contracts | 1 contract | Mock is simpler |
| Liquidation risk | None for suppliers | N/A | Not a concern |
| Withdrawal fees | None | None | Same behavior |
| Interface | `ISpokeBase` | Same | Frontend compatible |

**Key insight**: Real Aave yield requires borrowers. With zero utilization, suppliers earn ~0%. The mock simulates a configurable yield rate directly.

---

## Files Created

```
poc/
├── contracts/
│   └── aave-mock/
│       └── MockAaveSpoke.sol      # The mock contract
│
├── scripts/
│   └── deploy_aave_mock.ts        # Deployment script
│
└── deployments/
    └── aave-mock-hub.json         # Deployment output (after running)
```

---

## Interface Compatibility

The mock implements the same function signatures as Aave V4:

```solidity
// Supply (deposit)
function supply(
    uint256 reserveId,
    uint256 amount,
    address onBehalfOf
) external returns (uint256 shares, uint256 supplied);

// Withdraw
function withdraw(
    uint256 reserveId,
    uint256 amount,
    address onBehalfOf
) external returns (uint256 shares, uint256 withdrawn);

// View functions
function getUserSuppliedAssets(uint256 reserveId, address user) external view returns (uint256);
function getUserSuppliedShares(uint256 reserveId, address user) external view returns (uint256);
function getReserveSuppliedAssets(uint256 reserveId) external view returns (uint256);
function getReserveSuppliedShares(uint256 reserveId) external view returns (uint256);
```

**Frontend code needs no changes** when switching from mock to real Aave V4.

---

## How Yield Works

1. **On deposit**: User receives shares based on current `liquidityIndex`
2. **Over time**: `liquidityIndex` grows based on configured APY
3. **On withdrawal**: Shares convert to more underlying than deposited
4. **Yield tokens**: Minted on-demand by MockUSDCV2 (mock is a minter)

```
Example with 5% APY:
- User deposits 1000 USDC, gets 1000 shares (index = 1.0)
- After 1 year, index = 1.05
- User's 1000 shares = 1050 USDC
- On withdrawal, mock mints the extra 50 USDC
```

---

## Deployment

### Prerequisites

1. Local Anvil chains running (`./scripts/setup_chains.sh`)
2. CCTP deployed (`npx hardhat run scripts/deploy_cctp_v3.ts --network hub`)

### Deploy Mock Aave

```bash
npx hardhat run scripts/deploy_aave_mock.ts --network hub
```

This will:
1. Deploy `MockAaveSpoke`
2. Add it as a minter on `MockUSDCV2`
3. Create USDC reserve with 5% APY
4. Save deployment to `deployments/aave-mock-hub.json`

---

## Usage

### Supply USDC

```typescript
const mockAaveSpoke = await ethers.getContractAt("MockAaveSpoke", spokeAddress);
const usdc = await ethers.getContractAt("MockUSDCV2", usdcAddress);

// Approve
await usdc.approve(spokeAddress, amount);

// Supply
const [shares, supplied] = await mockAaveSpoke.supply(
  0,              // reserveId (0 = USDC)
  amount,         // amount in USDC (6 decimals)
  userAddress     // onBehalfOf
);
```

### Check Balance (with yield)

```typescript
// Get assets including accrued yield
const assets = await mockAaveSpoke.getUserSuppliedAssets(0, userAddress);

// Get raw shares
const shares = await mockAaveSpoke.getUserSuppliedShares(0, userAddress);
```

### Withdraw

```typescript
// Withdraw specific amount
const [shares, withdrawn] = await mockAaveSpoke.withdraw(
  0,              // reserveId
  amount,         // amount to withdraw
  userAddress     // must be caller
);

// Withdraw all
const [shares, withdrawn] = await mockAaveSpoke.withdraw(
  0,
  ethers.MaxUint256,  // max = withdraw all
  userAddress
);
```

### Adjust Yield Rate (Admin)

```typescript
// Change to 10% APY
await mockAaveSpoke.setYieldRate(0, 1000);  // 1000 bps = 10%
```

---

## Testing Yield Accrual

```typescript
describe("MockAaveSpoke", () => {
  it("should accrue yield over time", async () => {
    const amount = parseUnits("1000", 6);  // 1000 USDC

    // Supply
    await usdc.approve(mockAaveSpoke.address, amount);
    await mockAaveSpoke.supply(0, amount, user.address);

    // Check initial balance
    const initial = await mockAaveSpoke.getUserSuppliedAssets(0, user.address);
    expect(initial).to.equal(amount);

    // Fast-forward 1 year
    await ethers.provider.send("evm_increaseTime", [365 * 24 * 60 * 60]);
    await ethers.provider.send("evm_mine", []);

    // Check balance with yield (~5% APY)
    const withYield = await mockAaveSpoke.getUserSuppliedAssets(0, user.address);
    expect(withYield).to.be.closeTo(
      parseUnits("1050", 6),
      parseUnits("1", 6)  // tolerance
    );

    // Withdraw all
    await mockAaveSpoke.withdraw(0, ethers.MaxUint256, user.address);

    // Verify received full amount including yield
    const balance = await usdc.balanceOf(user.address);
    expect(balance).to.be.closeTo(parseUnits("1050", 6), parseUnits("1", 6));
  });
});
```

---

## Integration with YieldManager

The `YieldManager` contract bridges PrivacyPool to MockAaveSpoke:

```solidity
contract YieldManager {
    MockAaveSpoke public spoke;
    IERC20 public usdc;

    uint256 constant USDC_RESERVE_ID = 0;

    function deposit(uint256 amount) external onlyPrivacyPool {
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        usdc.approve(address(spoke), amount);
        spoke.supply(USDC_RESERVE_ID, amount, address(this));
    }

    function withdraw(uint256 amount) external onlyPrivacyPool {
        spoke.withdraw(USDC_RESERVE_ID, amount, address(this));
        usdc.safeTransfer(msg.sender, amount);
    }

    function getTotalValue() external view returns (uint256) {
        return spoke.getUserSuppliedAssets(USDC_RESERVE_ID, address(this));
    }
}
```

---

## Deployment Order (Full Stack)

```bash
# 1. Start local chains
./scripts/setup_chains.sh

# 2. Deploy CCTP (includes MockUSDCV2)
npx hardhat run scripts/deploy_cctp_v3.ts --network hub
npx hardhat run scripts/deploy_cctp_v3.ts --network client

# 3. Deploy Privacy Pool
npx hardhat run scripts/deploy_privacy_pool.ts --network hub
npx hardhat run scripts/deploy_privacy_pool.ts --network client

# 4. Deploy Mock Aave
npx hardhat run scripts/deploy_aave_mock.ts --network hub

# 5. Link chains
npx hardhat run scripts/link_privacy_pool.ts --network hub
npx hardhat run scripts/link_privacy_pool.ts --network client
```

---

## Future: Switching to Real Aave

When ready to test with real Aave V4 on testnet:

1. Deploy your contracts to Sepolia
2. Get testnet USDC from [Circle faucet](https://faucet.circle.com/)
3. Seed a small yield reserve (~20 USDC) in your YieldManager
4. Change the Spoke address in your config to real Aave V4
5. **No frontend code changes needed** - same interface

---

## Contract Reference

### MockAaveSpoke

| Function | Description |
|----------|-------------|
| `supply(reserveId, amount, onBehalfOf)` | Deposit tokens, receive shares |
| `withdraw(reserveId, amount, onBehalfOf)` | Burn shares, receive tokens + yield |
| `getUserSuppliedAssets(reserveId, user)` | Get balance including yield |
| `getUserSuppliedShares(reserveId, user)` | Get raw share count |
| `getReserveSuppliedAssets(reserveId)` | Total assets in pool |
| `getReserveLiquidityIndex(reserveId)` | Current yield index (RAY) |
| `addReserve(underlying, yieldBps, mintable)` | Admin: add new reserve |
| `setYieldRate(reserveId, yieldBps)` | Admin: change APY |

### Events

| Event | When |
|-------|------|
| `Supply(reserveId, caller, user, shares, amount)` | On deposit |
| `Withdraw(reserveId, caller, user, shares, amount)` | On withdrawal |
| `YieldMinted(reserveId, amount)` | When yield tokens are minted |
| `YieldRateUpdated(reserveId, newYieldBps)` | When APY changes |
