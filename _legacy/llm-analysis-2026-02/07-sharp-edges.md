# Sharp Edges Analysis: Railgun CCTP POC

**Date:** 2026-02-19
**Scope:** `/Volumes/T7/railgun/poc/contracts/`
**Focus:** Error-prone APIs, dangerous configurations, footgun designs

---

## 1. Module Delegation Pattern

**Files:**
- `/Volumes/T7/railgun/poc/contracts/privacy-pool/PrivacyPool.sol`
- `/Volumes/T7/railgun/poc/contracts/privacy-pool/storage/PrivacyPoolStorage.sol`
- `/Volumes/T7/railgun/poc/contracts/privacy-pool/modules/ShieldModule.sol`
- `/Volumes/T7/railgun/poc/contracts/privacy-pool/modules/TransactModule.sol`
- `/Volumes/T7/railgun/poc/contracts/privacy-pool/modules/MerkleModule.sol`
- `/Volumes/T7/railgun/poc/contracts/privacy-pool/modules/VerifierModule.sol`

### 1.1 Storage Collision Risk Between Modules

**Severity: Medium (design risk, currently mitigated)**

All four modules (`ShieldModule`, `TransactModule`, `MerkleModule`, `VerifierModule`) independently inherit from `PrivacyPoolStorage`. The router (`PrivacyPool`) also inherits `PrivacyPoolStorage`. Since modules execute via `delegatecall`, they all operate on the router's storage.

**Sharp Edge:** Each module is itself a concrete contract that could be deployed with its own storage. If any module declares its own state variables (beyond those inherited from `PrivacyPoolStorage`), those variables would collide with different slots depending on inheritance order.

Current state: No module declares additional storage variables today. However, this is a **fragile invariant**. A developer adding `uint256 tempVar;` to `ShieldModule` would create a storage collision because it would occupy a different slot than the same position in `PrivacyPoolStorage`'s layout when accessed via delegatecall.

The `__gap[49]` pattern in `PrivacyPoolStorage` (line 151) provides expansion room, but the gap size calculation is already potentially off. The storage layout contains:

- 4 address slots (modules)
- 3 address slots + 1 uint32 (CCTP config, packed)
- 1 mapping
- 1 address + 3 uint120 (treasury/fees, packing)
- 2 mappings
- Constants (no slots)
- 4 state vars (nextLeafIndex, merkleRoot, newTreeRoot, treeNumber)
- 2 fixed arrays (bytes32[16] each)
- 2 mappings
- 1 mapping + 1 bool (verifier)
- 1 mapping + 1 uint256 + 1 address + 1 bool
- `uint256[49] __gap`

No automated tool enforces that modules must not declare new state. Adding a CI check (e.g., `storage-layout` diff) would be prudent.

**Recommendation:** Add a comment in each module explicitly forbidding new state variables. Consider a compile-time assertion or a storage layout test that compares slots across `PrivacyPool` and each module.

### 1.2 Direct Calls to Module Contracts

**Severity: High (direct-call state corruption)**

Each module (`ShieldModule`, `TransactModule`, `MerkleModule`, `VerifierModule`) is a deployed contract with public/external functions. Nothing prevents a user from calling these functions directly on the module contract itself (not via `delegatecall` through the router).

**Example: `VerifierModule.setVerificationKey()`** (line 31-41 of VerifierModule.sol):
```solidity
function setVerificationKey(
    uint256 _nullifiers,
    uint256 _commitments,
    VerifyingKey calldata _verifyingKey
) external override {
    require(msg.sender == owner, "VerifierModule: Only owner");
    verificationKeys[_nullifiers][_commitments] = _verifyingKey;
}
```

If called directly on the module, this writes to the *module's own storage*, not the router's. The `owner` check reads from the module's storage slot for `owner`, which is uninitialized (`address(0)`) unless someone called `initialize()` on the module itself.

**Sharp Edge:** Since `owner` in the module's own storage is `address(0)` (never set), `msg.sender == owner` would fail for any non-zero caller. This accidentally prevents the worst case. However, `VerifierModule.setTestingMode()` (line 127) has the same pattern -- if someone could initialize the module directly, they could enable testingMode on the module's own storage (harmless for delegatecall users, but misleading).

**More dangerous:** `MerkleModule.initializeMerkle()` and `MerkleModule.insertLeaves()` have no access control at all -- they're meant to be called via delegatecall. If called directly on the MerkleModule contract, they would modify the module's own storage (harmless but confusing).

**Recommendation:** Add a guard in each module checking `address(this) == expectedRouter` or using a `onlyDelegatecall` modifier pattern:
```solidity
modifier onlyDelegatecall() {
    require(address(this) != _self, "Must be delegatecall");
    _;
}
```

### 1.3 `address(this)` Semantics in Delegatecall

**Severity: Medium (understood but fragile)**

Within modules executing via delegatecall, `address(this)` refers to the **router** (PrivacyPool), not the module. The codebase correctly leverages this:

- `ShieldModule.shield()` (line 62-63): `IMerkleModule(address(this)).getInsertionTreeNumberAndStartingIndex(numRequests)` -- This makes a regular CALL back to the router, which works because the router exposes these as view functions.
- `ShieldModule._transferTokenIn()` (line 234): `token.balanceOf(address(this))` -- Correctly reads the router's balance.
- `TransactModule._validateTransaction()` (line 289): `IVerifierModule(address(this)).verify(_transaction)` -- This makes a CALL back to the router.

**Sharp Edge:** The `address(this).call()` pattern within delegatecall context creates a **re-entrant call from the contract to itself**. In `ShieldModule.shield()`:

```solidity
// Line 69 (via delegatecall context)
IMerkleModule(address(this)).insertLeaves(insertionLeaves);
```

This triggers `PrivacyPool.insertLeaves()` (line 407), which checks `require(msg.sender == address(this), "Only self")` and then delegates to MerkleModule. The self-call pattern works, but it means:
1. The entire call stack is: User -> Router (delegatecall) -> ShieldModule -> Router (call) -> Router (delegatecall) -> MerkleModule
2. State changes in ShieldModule (like `lastEventBlock = block.number`) happen *after* the self-call returns, creating a window where storage is partially updated.
3. No reentrancy guard protects this flow.

**Risk:** If a malicious token's `transferFrom` (in `_transferTokenIn`) had a callback, it could re-enter `shield()` before `insertLeaves()` completes. The current code mitigates this by using `SafeERC20`, and USDC has no transfer callbacks. However, the architecture supports arbitrary ERC20 tokens via `CommitmentPreimage.token.tokenAddress`.

**Recommendation:** Add `ReentrancyGuard` to the `PrivacyPool` router or restrict supported tokens to a whitelist.

### 1.4 `msg.sender` Semantics in Delegatecall

**Severity: Medium**

In delegatecall context, `msg.sender` retains the original caller (the user who called the router). The code relies on this in:

- `ShieldModule._transferTokenIn()` (line 218): `privilegedShieldCallers[msg.sender]` -- checks if the *original caller* is privileged.
- `ShieldModule._processInternalShield()` (line 132): `privilegedShieldCallers[msg.sender]` -- but here `msg.sender` is `tokenMessenger` (for CCTP incoming shields), so the privileged check is against the TokenMessenger address, not the original user. This is correct behavior (CCTP shields should not be fee-exempt unless TokenMessenger is explicitly privileged).

- `TransactModule._transferTokenOut()` (line 347): `privilegedShieldCallers[recipient]` -- checks the *recipient address*, not `msg.sender`. This is an asymmetry: shield fee bypass is based on `msg.sender` (caller), but unshield fee bypass is based on `recipient`.

**Sharp Edge:** This asymmetry means:
- For shielding, the *adapter contract* must be the caller to bypass fees
- For unshielding, the *recipient* must be in the privileged list

In the yield adapter flow, the adapter is both the caller (for shield) and the recipient (for unshield via npk encoding). This works because the adapter address is set as privileged. But if someone unshields to the adapter address directly (not through the adapter contract), they would also bypass fees.

---

## 2. ERC4626 Vault Integration

**Files:**
- `/Volumes/T7/railgun/poc/contracts/yield/ArmadaYieldVault.sol`
- `/Volumes/T7/railgun/poc/contracts/yield/ArmadaYieldAdapter.sol`

### 2.1 Missing ERC4626 Functions

**Severity: Low-Medium (integration risk)**

`ArmadaYieldVault` inherits from `ERC20` but does NOT implement ERC4626 (IERC4626). Despite having `deposit()`, `redeem()`, `convertToShares()`, `convertToAssets()`, and `totalAssets()` -- all ERC4626 function names -- it is missing:

- `asset()` -- should return the underlying token address
- `maxDeposit()`, `maxMint()`, `maxRedeem()`, `maxWithdraw()`
- `previewDeposit()`, `previewMint()`, `previewWithdraw()` -- standard preview functions
- `mint(shares, receiver)` -- mint a specific number of shares
- `withdraw(assets, receiver, owner)` -- withdraw a specific amount of assets

The `previewRedeem()` function exists but takes a non-standard second parameter `owner_`:
```solidity
function previewRedeem(uint256 shares, address owner_) external view returns (uint256 assets)
```
Standard ERC4626 `previewRedeem(uint256 shares)` takes only one parameter and does not require an owner address (it shouldn't vary by owner). Here, the yield fee depends on the owner's cost basis, making preview fundamentally owner-dependent.

**Sharp Edge:** Any integration or tooling that assumes ERC4626 compliance will break. The non-standard `previewRedeem(uint256, address)` signature means:
1. Calling `previewRedeem(shares)` with one argument will fail (no matching function)
2. Generic ERC4626 wrappers (e.g., Yearn, aggregators) cannot integrate without adaptation
3. The `adapter.previewRedeem(shares)` function (line 313 of ArmadaYieldAdapter.sol) uses `vault.convertToAssets(shares)` which returns gross assets *before fees*, not net -- creating a misleading preview.

### 2.2 Non-Standard Rounding Behavior

**Severity: Low**

```solidity
// _convertToShares (line 382-393)
function _convertToShares(uint256 assets) internal view returns (uint256) {
    uint256 supply = totalSupply();
    if (supply == 0) { return assets; }  // 1:1 first deposit
    uint256 total = totalAssets();
    if (total == 0) { return assets; }
    return (assets * supply) / total;     // rounds DOWN
}

// _convertToAssets (line 398-404)
function _convertToAssets(uint256 shares) internal view returns (uint256) {
    uint256 supply = totalSupply();
    if (supply == 0) { return shares; }
    return (shares * totalAssets()) / supply;  // rounds DOWN
}
```

ERC4626 specifies that `convertToShares` should round DOWN (favoring the vault) and `convertToAssets` should also round DOWN. The implementations here do round down, which is correct. However, `deposit()` uses `_convertToShares` for minting, meaning users may receive fewer shares than expected for rounding. And `redeem()` uses `_convertToAssets`, so users may receive fewer assets. Both roundings favor the vault, which is standard.

**Sharp Edge:** The `if (total == 0) { return assets; }` case on line 389-390 is the dangerous edge. If `totalSupply() > 0` but `totalAssets() == 0` (e.g., if the Aave spoke reports zero assets due to a bug or depegging), this returns the raw asset amount as shares, which could massively inflate the share supply.

### 2.3 First Depositor Inflation Attack

**Severity: Medium**

The vault has no protection against the classic ERC4626 inflation attack:

1. Attacker deposits 1 wei of USDC, receives 1 share (1:1 first deposit, line 386)
2. Attacker directly transfers a large amount (e.g., 10,000 USDC) to the Aave spoke on behalf of the vault (or waits for yield to accrue significantly)
3. Now `totalAssets()` is high but `totalSupply()` is 1
4. Next depositor with `X` USDC gets `(X * 1) / 10001` shares, which rounds to 0 if `X < 10001`
5. The depositor's funds are absorbed into the existing share value

**Mitigation considerations:**
- USDC has 6 decimals, making the attack cheaper than 18-decimal tokens
- The vault deposits into Aave immediately (`spoke.supply()`), so direct donation to the vault address does not increase `totalAssets()` -- only Aave spoke balance matters
- However, an attacker could manipulate the Aave spoke's share price if they are the only supplier

**Recommendation:** Implement virtual shares/assets (OpenZeppelin's `_decimalsOffset()` pattern) or require a minimum initial deposit.

### 2.4 Preview vs Execution Divergence

**Severity: Medium**

`previewRedeem(shares, owner_)` (line 351-366) computes the yield fee using the current cost basis:
```solidity
uint256 costBasis = userCostBasisPerShare[owner_];
uint256 principalPortion = (shares * costBasis) / COST_BASIS_PRECISION;
```

The actual `redeem()` function (line 236-294) performs the same computation but also:
1. Clamps `principalPortion` to `totalPrincipal` (line 259-261)
2. Decrements `totalPrincipal`

The preview does NOT clamp to `totalPrincipal`. If `principalPortion > totalPrincipal` (possible due to accumulated rounding or multiple users redeeming), the preview will show a different fee than actual execution.

**Scenario:** With multiple users sharing the adapter identity (see Section 5), `totalPrincipal` can be smaller than the sum of individual principal portions due to rounding in the weighted average cost basis computation. Preview would overstate the yield (and therefore the fee), while actual execution would clamp and understate it.

---

## 3. CCTP Encoding/Decoding

**Files:**
- `/Volumes/T7/railgun/poc/contracts/cctp/ICCTPV2.sol`
- `/Volumes/T7/railgun/poc/contracts/privacy-pool/types/CCTPTypes.sol`
- `/Volumes/T7/railgun/poc/contracts/cctp/MockCCTPV2.sol`

### 3.1 abi.encodePacked vs abi.encode for Message Bodies

**Severity: Medium (format mismatch risk)**

The `BurnMessageV2.encode()` function (ICCTPV2.sol line 389) uses `abi.encodePacked`:
```solidity
return abi.encodePacked(
    BURN_MESSAGE_VERSION,   // 4 bytes
    burnToken,              // 32 bytes
    mintRecipient,          // 32 bytes
    amount,                 // 32 bytes (uint256 packed as 32 bytes)
    messageSender,          // 32 bytes
    maxFee,                 // 32 bytes
    feeExecuted,            // 32 bytes
    expirationBlock,        // 32 bytes
    hookData                // variable length
);
```

While `CCTPPayloadLib` (CCTPTypes.sol) uses `abi.encode` for the hook data payload:
```solidity
function encodeShield(ShieldData memory data) internal pure returns (bytes memory) {
    return abi.encode(CCTPPayload({
        messageType: MessageType.SHIELD,
        data: abi.encode(data)
    }));
}
```

**Sharp Edge:** `abi.encodePacked` concatenates without padding, while `abi.encode` pads to 32-byte boundaries. The two encoding schemes are mixed in the same message pipeline:
- Outer message envelope: `abi.encodePacked` (MessageV2 and BurnMessageV2)
- Inner hook data payload: `abi.encode` (CCTPPayload and ShieldData/UnshieldData)

This is **intentional** -- the outer format matches Circle's real CCTP wire format, while the inner payload uses standard ABI encoding for safety. However, this mixing creates a confusing mental model. A developer might try to decode the full message with `abi.decode`, which would fail because the outer layers are packed.

**Recommendation:** Add prominent comments at encoding/decoding boundaries explaining which scheme is used and why.

### 3.2 Hook Data Length Validation

**Severity: Low-Medium**

`BurnMessageV2.decodeForHook()` (line 441-456) handles empty hook data:
```solidity
if (messageBody.length > HOOK_DATA_OFFSET) {
    hookData = messageBody[HOOK_DATA_OFFSET:];
} else {
    hookData = "";
}
```

But `PrivacyPool.handleReceiveFinalizedMessage()` (line 191) then passes this to `CCTPPayloadLib.decode()`:
```solidity
CCTPPayload memory payload = CCTPPayloadLib.decode(hookData);
```

If `hookData` is empty, `abi.decode(hookData, (CCTPPayload))` will revert with a generic decoding error. There is no explicit check for empty hook data before decoding.

**Sharp Edge:** A CCTP message without hook data (e.g., a standard `depositForBurn` without hooks) would cause a cryptic revert in the PrivacyPool handler. The real CCTP v2 protocol may deliver such messages if the TokenMessenger routes a non-hook burn to a hook-enabled recipient.

**Recommendation:** Add `require(hookData.length > 0, "PrivacyPool: Empty hook data")` before decoding.

### 3.3 Message Format Version Confusion

**Severity: Low**

Both `MessageV2` and `BurnMessageV2` define `VERSION = 1`:
```solidity
uint32 constant MESSAGE_VERSION = 1;      // MessageV2 (line 222)
uint32 constant BURN_MESSAGE_VERSION = 1;  // BurnMessageV2 (line 374)
```

The `BurnMessage` legacy library (line 492-540) wraps `BurnMessageV2` and uses the same version. However, there is a `BurnMessage` (v1) library that exists purely for backward compatibility and delegates to `BurnMessageV2.decode()`.

**Sharp Edge:** Code searching for "version 1" messages could confuse the legacy wrapper with the actual v2 format. The legacy library's `decode()` returns an `address burnToken` (20 bytes) while the v2 format stores it as `bytes32` (32 bytes). If the legacy decode is used on a real CCTP v2 message, the address conversion works but loses the upper 12 zero bytes -- which is fine for Ethereum addresses but would silently truncate non-Ethereum addresses.

### 3.4 Endianness/Padding Consistency

**Severity: Low**

The `MessageV2` library decodes fields using explicit byte slicing with big-endian interpretation:
```solidity
nonce = uint64(bytes8(message[NONCE_OFFSET:NONCE_OFFSET + 8]));
```

This matches Circle's real CCTP format (big-endian packed). The `BurnMessageV2` amount field (32 bytes at offset 68) is decoded as:
```solidity
amount = uint256(bytes32(messageBody[AMOUNT_OFFSET:AMOUNT_OFFSET + 32]));
```

This correctly interprets the big-endian 256-bit value. The `abi.encodePacked` encoding of `uint256` also produces big-endian bytes. Consistency is maintained.

**Sharp Edge:** The `nonce` field is 8 bytes in the message (uint64) but the `burnNonce` from TokenMessenger is also uint64. However, in `MockMessageTransmitterV2._emitBurnMessage()` (line 375), a *different* nonce (`nextMessageNonce++`) is used for the outer message, while the `burnNonce` from TokenMessenger is embedded in the BurnMessageV2 body. These are two distinct nonce spaces (message-level vs burn-level) with no cross-reference, which could confuse relayer implementations.

---

## 4. Fee Calculation

**Files:**
- `/Volumes/T7/railgun/poc/contracts/privacy-pool/modules/ShieldModule.sol` (lines 254-272)
- `/Volumes/T7/railgun/poc/contracts/privacy-pool/modules/TransactModule.sol` (lines 384-400)

### 4.1 Fee-Inclusive vs Fee-Exclusive Confusion

**Severity: Medium**

The `_getFee` function exists in both `ShieldModule` and `TransactModule` with identical logic:
```solidity
function _getFee(
    uint136 _amount,
    bool _isInclusive,
    uint120 _feeBP
) internal pure returns (uint120 base, uint120 fee) {
    if (_isInclusive) {
        // Fee is included in amount
        base = uint120(_amount - (_amount * _feeBP) / BASIS_POINTS);
        fee = uint120(_amount) - base;
    } else {
        // Fee is on top of amount
        base = uint120(_amount);
        fee = uint120((BASIS_POINTS * _amount) / (BASIS_POINTS - _feeBP) - _amount);
    }
}
```

All call sites use `_isInclusive = true`:
- `ShieldModule._transferTokenIn()` line 222: `_getFee(_note.value, true, shieldFee)`
- `ShieldModule._processInternalShield()` line 133: `_getFee(_request.preimage.value, true, shieldFee)`
- `TransactModule._executeCCTPBurn()` line 184: `_getFee(uint136(unshieldAmount), true, unshieldFee)`
- `TransactModule._transferTokenOut()` line 351: `_getFee(_note.value, true, unshieldFee)`

**Sharp Edge:** The `_isInclusive = true` semantic means: "the user specifies a total amount, and the fee is deducted from it." So if a user shields 100 USDC with a 1% fee, they get 99 USDC shielded and 1 USDC goes to treasury. The user sends 99 USDC (base) to the contract and 1 USDC (fee) to treasury.

But in `ShieldModule._transferTokenIn()` (lines 233-243):
```solidity
// Transfer base amount to this contract
token.safeTransferFrom(msg.sender, address(this), base);
// Transfer fee to treasury
if (feeAmount > 0 && treasury != address(0)) {
    token.safeTransferFrom(msg.sender, treasury, feeAmount);
}
```

The user's original `_note.value` (e.g., 100) in the `CommitmentPreimage` is the fee-inclusive amount. The commitment recorded in the Merkle tree uses `base` (99). But the `ShieldRequest.preimage.value` passed by the user must be the *gross* amount from which the fee is deducted. This means the user must approve `base + feeAmount = _note.value` total tokens.

**Confusion vector:** Frontend developers might set `_note.value` to the desired *net* shield amount (what the user wants in-pool), but the contract treats it as the gross amount. There is no documentation clarifying that `value` means "amount from which fee is deducted" rather than "amount to be shielded."

### 4.2 Rounding Exploitation via Small Amounts

**Severity: Low-Medium**

The fee calculation:
```solidity
base = uint120(_amount - (_amount * _feeBP) / BASIS_POINTS);
fee = uint120(_amount) - base;
```

For small amounts, `(_amount * _feeBP) / BASIS_POINTS` can round down to 0, making `fee = 0`.

**Example:** With `shieldFee = 50` (0.5%), for `_amount = 199`:
- `(199 * 50) / 10000 = 9950 / 10000 = 0` (integer division)
- `base = 199 - 0 = 199`
- `fee = 199 - 199 = 0`

An attacker could shield many small amounts (e.g., 199 * 1000 = 199,000 units) to completely avoid fees, while a single shield of 199,000 units would pay `(199000 * 50) / 10000 = 995` in fees.

**Sharp Edge:** With USDC (6 decimals), 199 raw units = 0.000199 USDC, so the gas cost of each shield far exceeds the avoided fee. However, if batched via a single `shield()` call with many `ShieldRequest` entries, the gas amortization makes fee grinding feasible for larger per-request amounts.

The threshold for zero fee at 50 bps is `_amount < 10000/50 = 200` raw USDC units (0.0002 USDC). At 100 bps (1%), the threshold is 100 units (0.0001 USDC). Economically insignificant for USDC but potentially meaningful for higher-value tokens.

**Recommendation:** Add a minimum shield amount requirement or a minimum fee floor.

### 4.3 Fee Bypass Asymmetry

**Severity: Medium (design concern)**

As noted in Section 1.4, fee bypass is checked differently for shield vs unshield:

- **Shield** (ShieldModule line 218): `privilegedShieldCallers[msg.sender]` -- checks the caller
- **Unshield** (TransactModule line 347): `privilegedShieldCallers[recipient]` -- checks the recipient

**Sharp Edge:** Any user who sets their unshield `npk` (which encodes as `recipient`) to the adapter address would bypass unshield fees. In normal operation this is fine because the adapter re-shields the USDC. But if a user constructs a transaction with `npk = bytes32(uint256(uint160(adapterAddress)))` and `UnshieldType.NORMAL`, the USDC would be sent to the adapter address fee-free, and the adapter has no mechanism to prevent this or ensure re-shielding occurs.

The `rescueTokens()` function on the adapter (line 325-331) is owner-only and could recover such funds, but the fee revenue is permanently lost.

### 4.4 Cross-Chain Fee Double Deduction

**Severity: Low (currently consistent, but fragile)**

For cross-chain shields, fees are applied at multiple layers:
1. **CCTP relayer fee** (`maxFee`): Deducted from the gross burn amount at the protocol level
2. **Privacy pool shield fee** (`shieldFee`): Applied in `_processInternalShield()` on the Hub

In `PrivacyPool.handleReceiveFinalizedMessage()` (line 188):
```solidity
uint256 actualAmount = grossAmount - feeExecuted;
```

Then in `processIncomingShield()` (line 91):
```solidity
require(amount <= uint256(data.value), "ShieldModule: Amount exceeds declared value");
uint256 commitmentAmount = amount;
```

And in `_processInternalShield()` (line 132-135):
```solidity
if (shieldFee > 0 && !privilegedShieldCallers[msg.sender]) {
    (uint120 base, uint120 feeAmount) = _getFee(_request.preimage.value, true, shieldFee);
    ...
}
```

**Sharp Edge:** The commitment value is set to `uint120(commitmentAmount)` where `commitmentAmount = actualAmount` (line 93, 106). But `_processInternalShield` then applies the shield fee on top. So the user pays: `grossAmount - cctpFee - shieldFee`. The shield fee is applied to `commitmentAmount` (the already-fee-reduced amount), so it's a fee-on-fee scenario.

If `msg.sender` is `tokenMessenger` and it's not in `privilegedShieldCallers`, the cross-chain shield pays both CCTP fee AND shield fee. This is correct behavior but should be clearly documented for users calculating expected received amounts.

---

## 5. Adapter as Shared Identity

**Files:**
- `/Volumes/T7/railgun/poc/contracts/yield/ArmadaYieldAdapter.sol`
- `/Volumes/T7/railgun/poc/contracts/yield/ArmadaYieldVault.sol`

### 5.1 Cost Basis Corruption Across Users

**Severity: High (fundamental design tension)**

All privacy pool users interact with the vault through a single adapter address. The adapter calls `vault.deposit(amount, address(this))` (line 197), so all deposits are credited to `address(adapter)`. The vault tracks cost basis per address:

```solidity
// ArmadaYieldVault.deposit() lines 205-213
if (existingShares == 0) {
    userCostBasisPerShare[receiver] = (assets * COST_BASIS_PRECISION) / shares;
} else {
    uint256 oldBasis = userCostBasisPerShare[receiver];
    userCostBasisPerShare[receiver] = (oldBasis * existingShares + assets * COST_BASIS_PRECISION)
        / (existingShares + shares);
}
```

Since `receiver = address(adapter)` for all users, the cost basis is a weighted average across ALL users' deposits. When one user redeems:

```solidity
// ArmadaYieldVault.redeem() lines 255-256
uint256 costBasis = userCostBasisPerShare[owner_];  // owner_ = adapter
uint256 principalPortion = (shares * costBasis) / COST_BASIS_PRECISION;
```

The `principalPortion` uses the *aggregate* cost basis, not the individual user's. This means:
- Early depositors (who deposited when share price was low) will have their yield understated
- Late depositors (who deposited when share price was high) will have their yield overstated
- The 10% yield fee calculation is therefore incorrect for individual users

**Example:**
1. User A deposits 1000 USDC when share price = 1.0 (gets 1000 shares, costBasis = 1.0)
2. Share price rises to 1.1
3. User B deposits 1000 USDC when share price = 1.1 (gets ~909 shares, costBasis becomes weighted avg)
4. New costBasis = (1.0 * 1000 + 1.1 * 909 * 1e18/909) / (1000 + 909) ~= 1.047
5. When User A redeems 1000 shares: principalPortion = 1000 * 1.047 = 1047, grossAssets = 1100
6. Yield = 1100 - 1047 = 53 (should be 100), fee = 5.3 (should be 10)
7. User A underpays yield fee; User B would overpay

**Sharp Edge:** This is not a bug in isolation -- the privacy-preserving design intentionally obscures individual user identity. The aggregate cost basis is a deliberate simplification. However, it creates an **economic incentive to time deposits**: depositing right before a redemption wave allows capturing others' yield fee savings.

### 5.2 Share Accounting and Transfer Risks

**Severity: Medium**

The adapter holds vault shares (`balanceOf(adapter) > 0`) that are actually owned by privacy pool users via shielded notes. Since `ArmadaYieldVault` extends `ERC20`, standard `transfer()` and `transferFrom()` are available.

**Sharp Edge:** If the adapter owner calls `rescueTokens(address(shareToken), attacker, amount)` (line 325-331), they can steal vault shares that belong to privacy pool users. The `onlyOwner` modifier protects this, but it's a centralization risk -- the adapter owner has full custody of all deposited yield funds.

Additionally, anyone who receives vault shares via `transfer()` to the adapter address (not through `deposit()`) would corrupt the cost basis accounting, since `deposit()` updates `totalPrincipal` but a raw transfer does not.

### 5.3 Approval Patterns

**Severity: Low**

The adapter sets up approvals in the constructor and in the flow:

1. **Constructor** (line 104): `usdc.approve(_vault, type(uint256).max)` -- infinite approval to vault
2. **lendAndShield** (line 215): `shareToken.approve(privacyPool, shares)` -- per-tx approval
3. **redeemAndShield** (line 272): `shareToken.approve(address(vault), shares)` -- per-tx approval
4. **redeemAndShield** (line 291): `usdc.approve(privacyPool, assets)` -- per-tx approval

**Sharp Edge:** The infinite USDC approval to the vault in the constructor is a gas optimization but creates a standing approval. If the vault contract is ever upgraded (or if `vault` is set to a malicious address), all USDC held by the adapter could be drained.

The per-transaction approvals in `lendAndShield` and `redeemAndShield` do not reset to 0 first, relying on the fact that the subsequent `shield()` or `redeem()` will consume the exact approved amount. If `shield()` or `redeem()` reverts after partial consumption, a residual approval remains.

---

## 6. Initializer Pattern

**Files:**
- `/Volumes/T7/railgun/poc/contracts/privacy-pool/PrivacyPool.sol` (lines 53-93)
- `/Volumes/T7/railgun/poc/contracts/privacy-pool/PrivacyPoolClient.sol` (lines 67-87)

### 6.1 Custom Initialize Without OpenZeppelin Initializable

**Severity: Medium-High**

Both `PrivacyPool` and `PrivacyPoolClient` use a bare `require(!initialized)` pattern:

```solidity
// PrivacyPool.sol line 64
require(!initialized, "PrivacyPool: Already initialized");
// ... set state ...
initialized = true;

// PrivacyPoolClient.sol line 76
require(!initialized, "PrivacyPoolClient: Already initialized");
// ... set state ...
initialized = true;
```

**Missing protections compared to OpenZeppelin `Initializable`:**

1. **No `initializer` modifier with reentrancy protection:** OZ's modifier prevents the initialize function from being re-entered during execution. A malicious module (e.g., if `_merkleModule` has a callback in `initializeMerkle()`) could re-enter `initialize()` before `initialized = true` is set.

2. **No `_disableInitializers()` in constructor:** OZ recommends calling this in the constructor to prevent the implementation contract from being initialized when used behind a proxy. Neither contract does this.

3. **No `reinitializer(version)` support:** If a future upgrade needs to run a new initializer, the `bool initialized` pattern cannot distinguish between versions. OZ's `uint8 _initialized` counter supports versioned re-initialization.

### 6.2 Front-Running Initialize Between Deploy and Init

**Severity: High (if deployed without proxy)**

Neither `PrivacyPool` nor `PrivacyPoolClient` initializes in the constructor. If deployed as a standalone contract (not behind a proxy with an atomic deploy+init), there is a window between deployment and the `initialize()` call where an attacker can front-run:

```
Block N: deploy PrivacyPool            -> attacker sees mempool
Block N+1: attacker calls initialize() -> sets owner = attacker
```

The attacker can then:
1. Set themselves as owner
2. Enable testing mode (bypass SNARK verification)
3. Set verification keys to accept any proof
4. Shield and unshield funds at will

**Mitigations present:** None in the contract code. This must be handled at the deployment level (e.g., using CREATE2 with a deterministic address, or deploying behind a proxy with atomic initialization).

**Recommendation:** Either:
- Use OpenZeppelin `Initializable` with `_disableInitializers()` in the constructor
- Deploy behind a proxy with atomic initialization
- Use a factory contract that deploys and initializes in a single transaction

### 6.3 PrivacyPool Delegatecall During Initialize

**Severity: Low**

During initialization, `PrivacyPool.initialize()` performs a delegatecall to `MerkleModule.initializeMerkle()` (line 90) *before* setting `initialized = true` (line 92). The `initializeMerkle()` function has no access control and no check on the `initialized` flag. If `initializeMerkle()` were to revert, the entire `initialize()` would revert, leaving the contract in an uninitialized state where it can be re-initialized.

If `initializeMerkle()` were to make a callback (it does not currently -- it only computes Poseidon hashes and writes storage), the callback could re-enter `initialize()` because `initialized` is still `false`.

---

## 7. Additional Sharp Edges

### 7.1 testingMode Bypass (VERIFICATION_BYPASS)

**File:** `/Volumes/T7/railgun/poc/contracts/privacy-pool/PrivacyPool.sol` (lines 337-383)

```solidity
if (tx.origin == VERIFICATION_BYPASS) {
    return true;
}
```

Where `VERIFICATION_BYPASS = 0x000000000000000000000000000000000000dEaD`. This allows ANY transaction where `tx.origin` is the dead address to bypass proof verification. While this is intended for gas estimation by relayers, it is a permanent backdoor if not removed before production. The `testingMode` flag is controllable by the owner, but the `VERIFICATION_BYPASS` check is hardcoded and cannot be disabled.

**Sharp Edge:** If a relayer constructs a transaction for gas estimation with `tx.origin = 0xdEaD`, the proofs are not verified. If the estimation transaction is somehow submitted to chain (e.g., by a malfunctioning relayer or MEV bot), invalid proofs would be accepted.

### 7.2 ArmadaTreasury.recordFee() Has No Access Control

**File:** `/Volumes/T7/railgun/poc/contracts/yield/ArmadaTreasury.sol` (lines 105-112)

```solidity
function recordFee(address token, address from, uint256 amount) external {
    totalCollected[token] += amount;
    emit FeeReceived(token, from, amount);
}
```

Anyone can call `recordFee()` with arbitrary parameters, inflating the `totalCollected` counter. This is a tracking-only variable and does not affect fund custody, but it corrupts accounting data and emits misleading events.

### 7.3 uint120 Truncation in Cross-Chain Shield

**File:** `/Volumes/T7/railgun/poc/contracts/privacy-pool/modules/ShieldModule.sol` (line 106)

```solidity
value: uint120(commitmentAmount)
```

Where `commitmentAmount` is a `uint256`. If `commitmentAmount` exceeds `type(uint120).max` (~1.33 * 10^36), silent truncation occurs. For USDC with 6 decimals, this represents ~1.33 * 10^30 USDC, far exceeding total supply. However, the truncation is unchecked and would silently lose funds if a token with different decimals were used.

### 7.4 SafeApprove Deprecation in TransactModule

**File:** `/Volumes/T7/railgun/poc/contracts/privacy-pool/modules/TransactModule.sol` (line 200)

```solidity
IERC20(usdc).safeApprove(tokenMessenger, base);
```

OpenZeppelin's `safeApprove` reverts if the current allowance is non-zero (unless setting to 0 or from 0). If a previous `atomicCrossChainUnshield` partially consumed the approval (e.g., due to a revert after approve but before burn), the next call would revert. The `PrivacyPoolClient.crossChainShield()` correctly handles this with a reset-then-approve pattern (line 129-130), but `TransactModule` does not.

### 7.5 Governor Quorum Calculation Includes Abstain

**File:** `/Volumes/T7/railgun/poc/contracts/governance/ArmadaGovernor.sol` (lines 327-331)

```solidity
function _quorumReached(uint256 proposalId) internal view returns (bool) {
    Proposal storage p = _proposals[proposalId];
    return (p.forVotes + p.abstainVotes) >= quorum(proposalId);
}
```

Abstain votes count toward quorum but not toward the majority. This is a documented design choice (matching OpenZeppelin Governor), but it means an attacker with enough tokens can push a proposal past quorum by abstaining, then rely on a small number of "for" votes to exceed "against" votes.

### 7.6 TreasurySteward Action Execution Unchecked Return Data

**File:** `/Volumes/T7/railgun/poc/contracts/governance/TreasurySteward.sol` (lines 136-138)

```solidity
(bool success, bytes memory returnData) = action.target.call{value: action.value}(action.data);
require(success, string(abi.encodePacked("TreasurySteward: execution failed: ", returnData)));
```

The error message concatenation with raw `returnData` bytes can produce unreadable error messages and may consume excessive gas for large return data. Additionally, `abi.encodePacked(string, bytes)` creates ambiguous encoding if the bytes contain string-like data.

---

## Summary of Findings by Severity

| # | Finding | Severity | Category |
|---|---------|----------|----------|
| 1.2 | Modules callable directly (bypasses router) | High | Delegation |
| 5.1 | Cost basis corruption across users via shared adapter | High | Vault |
| 6.2 | Front-running initialize() between deploy and init | High | Initialization |
| 1.3 | Self-call pattern lacks reentrancy protection | Medium | Delegation |
| 1.4 | Fee bypass asymmetry (caller vs recipient) | Medium | Fees |
| 2.1 | Non-standard ERC4626 with misleading function names | Medium | Vault |
| 2.3 | First depositor inflation attack (no virtual shares) | Medium | Vault |
| 2.4 | previewRedeem diverges from actual redeem | Medium | Vault |
| 3.1 | Mixed abi.encodePacked/abi.encode in message pipeline | Medium | CCTP |
| 4.1 | Fee-inclusive semantics underdocumented | Medium | Fees |
| 6.1 | Custom initializer lacks OZ protections | Medium | Initialization |
| 7.1 | VERIFICATION_BYPASS hardcoded backdoor | Medium | Verification |
| 1.1 | Storage collision fragility (no enforcement) | Medium | Delegation |
| 3.2 | No empty hookData validation before decode | Low-Medium | CCTP |
| 4.2 | Fee rounding to zero for small amounts | Low-Medium | Fees |
| 4.3 | Unshield fee bypass via adapter-addressed npk | Medium | Fees |
| 4.4 | Cross-chain fee double deduction | Low | Fees |
| 5.2 | Adapter owner can steal vault shares (centralization) | Medium | Vault |
| 5.3 | Infinite USDC approval to vault | Low | Vault |
| 7.2 | recordFee() has no access control | Low | Treasury |
| 7.3 | uint120 truncation unchecked | Low | Types |
| 7.4 | safeApprove without prior reset in TransactModule | Low | Approval |
| 7.5 | Abstain votes count toward quorum | Low | Governance |
| 7.6 | Raw returnData in error string | Low | Governance |
| 3.3 | Legacy BurnMessage version confusion | Low | CCTP |
| 3.4 | Dual nonce spaces (message vs burn) | Low | CCTP |
