# Function-Level Deep Analysis Report: Railgun CCTP POC

**Analyzed**: 2026-02-19
**Method**: Ultra-granular per-function analysis (audit-context-building:function-analyzer)
**Scope**: 6 critical functions across privacy pool, yield, and crowdfund subsystems

---

## Functions Analyzed

| # | Function | File | Subsystem |
|---|----------|------|-----------|
| 1 | `ShieldModule._getFee` / `_transferTokenIn` | `ShieldModule.sol:254-272` / `L218-248` | Privacy Pool |
| 2 | `TransactModule._executeTransact` (nullifier flow) | `TransactModule.sol:51-70, 241-245, 315-316` | Privacy Pool |
| 3 | `PrivacyPool.handleReceiveFinalizedMessage` | `PrivacyPool.sol:161-208` | Cross-Chain |
| 4 | `ArmadaYieldAdapter.lendAndShield` | `ArmadaYieldAdapter.sol:155-218` | Yield |
| 5 | `ArmadaYieldVault.redeem` | `ArmadaYieldVault.sol:236-294` | Yield |
| 6 | `ArmadaCrowdfund.finalize` + `_computeAllocation` | `ArmadaCrowdfund.sol:222-307, 467-485` | Crowdfund |

---

## 1. ShieldModule: _getFee and _transferTokenIn

**File**: `contracts/privacy-pool/modules/ShieldModule.sol`

### 1.1 _getFee (L254-272)

**Purpose**: Computes the fee and base amount from a shield deposit. The fee model is multiplicative/inclusive: fee is deducted from the deposit amount.

**Formula**: `fee = (amount * feeBps) / 10000`, then `base = amount - fee`.

**Key Invariant**: `base + fee == amount` always holds (no rounding leakage).

**Block-by-Block**:
- L258: Reads `shieldFee` from storage (set by owner via `setFees`)
- L260-262: Privileged caller check — if `privilegedShieldCallers[msg.sender]`, fee = 0, base = amount
- L264: `fee = (amount * feeBps) / 10000` — integer division rounds DOWN, favoring the user (less fee)
- L265: `base = amount - fee` — exact, no rounding
- L266: Intermediate type `uint136` for `amount * feeBps` prevents overflow for `uint120` amounts

**Observations**:
- Fee calculation uses multiplicative model: `base = amount - (amount * feeBps) / 10000`
- Spec (README) describes additive model: `base = amount * 10000 / (10000 + feeBps)`
- At 50 bps these diverge by ~0.0025%, but at higher rates the difference grows (see spec compliance report)
- The `uint136` intermediate is sufficient: max `uint120` (1.329e36) * 10000 = 1.329e40, well within `uint136` range (8.7e40)

### 1.2 _transferTokenIn (L218-248)

**Purpose**: Transfers USDC from user to contract, enforcing exact balance receipt to defend against fee-on-transfer tokens.

**Block-by-Block**:
- L234: `balanceBefore = token.balanceOf(address(this))`
- L235: `token.safeTransferFrom(msg.sender, address(this), base)`
- L238: `require(balanceAfter - balanceBefore == base)` — exact balance check
- L241-242: If treasury != address(0) and fee > 0, transfers fee to treasury

**Key Invariant (INV-SM-3)**: Balance check ensures exact token receipt.

**Observations**:
- No reentrancy guard on `shield()`. The `safeTransferFrom` at L235 is an external call. For standard USDC (no callbacks), this is safe. For ERC777-like tokens, reentrancy into `shield()` before merkle insertion is possible.
- If `treasury == address(0)` and fees are configured, the fee is computed but NOT transferred. User pays only `base`, fee is effectively waived. The commitment records `base` as the value.

---

## 2. TransactModule: Nullifier and Unshield Flow

**File**: `contracts/privacy-pool/modules/TransactModule.sol`

### 2.1 Two-Pass Architecture (L51-70)

**Purpose**: Processes an array of transactions with a critical two-pass approach: first nullify ALL inputs across ALL transactions, THEN execute transfers.

**Pass 1 (Nullification Loop)**:
- For each transaction, verifies SNARK proof (or skips if testingMode)
- Checks `adaptContract == address(0) || adaptContract == msg.sender` (L241-245)
- Validates adaptParams hash matches if adaptContract is set
- Accumulates new commitments
- Records nullifiers — `require(!nullifiers[treeNumber][nullifier])` then `nullifiers[treeNumber][nullifier] = true` (L315-316)

**Pass 2 (Transfer Loop)**:
- For each transaction with unshield preimage, transfers tokens to recipient
- Fee exemption: checks `privilegedShieldCallers[recipient]` (NOT caller)

**Key Invariants**:
- **INV-TM-1**: Nullifier uniqueness enforced before any token transfers
- **INV-TM-2**: Two-pass architecture prevents partial-execution attacks
- **INV-TM-4**: `adaptContract` binding: `adaptContract == address(0) || adaptContract == msg.sender`

**Observations**:
- Fee bypass on unshields checks the RECIPIENT (`privilegedShieldCallers[recipient]`), not the caller. This is intentional for the adapter pattern (adapter is the recipient) but creates an asymmetry with shield fees (which check the CALLER).
- The `safeApprove` in `_executeCCTPBurn` (L200) does NOT reset allowance to 0 first, unlike the Client's implementation. If a CCTP burn reverts after approval but before consumption, the stale allowance could block subsequent burns.

---

## 3. PrivacyPool: handleReceiveFinalizedMessage

**File**: `contracts/privacy-pool/PrivacyPool.sol` (L161-208)

### 3.1 Purpose

Handles incoming CCTP V2 messages on the Hub chain. Called by TokenMessenger after USDC is minted. Decodes the hook data to create a shielded commitment for the cross-chain depositor.

### 3.2 Block-by-Block

- L169: `require(msg.sender == address(tokenMessenger))` — only TokenMessenger can call
- L174-177: `sender` parameter is silently discarded: `(sender); // Silence unused variable warning`
- L180: Decodes hookData via `CCTPPayloadLib.decodeShieldPayload`
- L188-193: Extracts commitment data from decoded payload
- L196-208: Calls `_processInternalShield` to create merkle commitment

### 3.3 Key Invariants

- **INV-HF-1**: Only tokenMessenger can trigger cross-chain shield
- **INV-HF-4**: Remote sender (source chain originator) is NOT validated

### 3.4 Observations

- **Missing remoteDomain validation**: The Hub does NOT check `remoteDomain` against registered `remotePools`. This means a CCTP message from ANY domain would be accepted. The Client correctly validates `remoteDomain == hubDomain` at L198.
- **Missing sender validation**: The `sender` bytes32 parameter (identifying the remote contract) is discarded. An attacker who can craft valid CCTP messages from an unregistered domain could create unauthorized commitments.
- **Mitigation**: CCTP's own message authentication (attestation signatures from Circle) prevents arbitrary message injection. The risk depends on whether CCTP guarantees the sender field is the actual calling contract.

---

## 4. ArmadaYieldAdapter: lendAndShield

**File**: `contracts/yield/ArmadaYieldAdapter.sol` (L155-218)

### 4.1 Purpose

Atomic yield operation: unshields USDC from privacy pool via SNARK proof, deposits into yield vault, and shields the resulting vault shares back to the user's note public key (npk). The entire operation is bound by the SNARK proof's adaptContract/adaptParams fields.

### 4.2 Block-by-Block

- L162: `require(msg.sender != address(0))` — prevents zero-address caller
- L165-167: Constructs `adaptParams` from `(npk, ciphertext)` and verifies hash matches transaction
- L168-176: `YieldAdaptParams.verify()` — pure hash comparison ensuring the adapter cannot change the re-shield destination
- L181-191: Calls `privacyPool.transact()` to unshield USDC. The adapter is the `adaptContract` bound in the proof
- L193-194: Reads amount from `_transaction.unshieldPreimage.value` (from calldata, not actual balance)
- L197: `shares = vault.deposit(amount, address(this))` — deposits USDC, receives ayUSDC shares
- L200-212: Constructs ShieldRequest with user's npk and `uint120(shares)`
- L215-216: Approves privacy pool for shares, calls `shield()` to re-shield shares

### 4.3 Key Invariants

- **INV-LA-1**: SNARK proof binds adapter address and re-shield destination (npk + ciphertext)
- **INV-LA-2**: adaptParams prevents adapter from changing re-shield recipient
- **INV-LA-3**: Entire operation is atomic — any step failure reverts everything
- **INV-LA-5**: Adapter USDC balance after lendAndShield is 0

### 4.4 Observations

- **uint120 truncation** at L209: `uint120(shares)` silent truncation if shares > type(uint120).max. Economically infeasible for USDC-denominated vaults.
- **Amount from calldata, not balance**: L193 reads amount from `_transaction.unshieldPreimage.value`, not from actual USDC balance. If adapter loses privileged status and a fee is charged, the vault deposit would attempt a larger amount than available.
- **Shared identity**: All privacy pool users interact with vault through adapter's address. The vault sees a single depositor. Cost basis tracking (`userCostBasisPerShare[adapter]`) is reset on each `lendAndShield`.
- **Infinite approval**: Constructor at L104 sets `type(uint256).max` approval to vault.

---

## 5. ArmadaYieldVault: redeem

**File**: `contracts/yield/ArmadaYieldVault.sol` (L236-294)

### 5.1 Purpose

Redeems vault shares for underlying USDC. Calculates gross asset value, determines yield portion via cost basis tracking, applies 10% yield fee, and transfers net assets to receiver.

### 5.2 Block-by-Block

- L241-242: Input validation — `shares > 0`, `receiver != address(0)`
- L245-249: Allowance check for non-owner callers
- L252: `grossAssets = _convertToAssets(shares)` — floor division, favors vault
- L255-256: `principalPortion = (shares * costBasis) / COST_BASIS_PRECISION`
- L259-262: Clamps `principalPortion` to `totalPrincipal` to prevent underflow
- L267: `_burn(owner_, shares)` — CEI pattern, burn BEFORE external calls
- L270: `spoke.withdraw(reserveId, grossAssets, address(this))` — external call to Aave
- L275-279: Yield fee: `yieldFee = (yield_ * YIELD_FEE_BPS) / BPS_DENOMINATOR` = 10% of yield
- L281: `assets = grossAssets - yieldFee`
- L284-288: Fee transfer to treasury + `recordFee` callback
- L291: `underlying.safeTransfer(receiver, assets)`

### 5.3 Key Invariants

- **INV-RD-1**: `assets + yieldFee == grossAssets` (no value leakage)
- **INV-RD-2**: Yield fee only charged when `grossAssets > principalPortion`
- **INV-RD-3**: `totalPrincipal` clamped to prevent underflow
- **INV-RD-4**: Shares burned BEFORE external calls (CEI)
- **INV-RD-5**: `_convertToAssets` floor division favors vault

### 5.4 Observations

- **Cost basis corruption via ERC20 transfer**: If shares are transferred via standard `transfer()`, recipient's `userCostBasisPerShare` is 0, treating entire value as yield (10% fee on everything). No `_transfer` override prevents this.
- **Treasury dependency**: `IArmadaTreasury(treasury).recordFee` at L287 is an external call. If treasury is misconfigured or reverts, ALL redemptions are blocked.
- **No virtual shares**: `_convertToShares` divides by `totalAssets()`. A first depositor could manipulate the exchange rate via direct token donation to the spoke contract. Mitigated by single-depositor pattern (adapter is the only depositor in practice).

---

## 6. ArmadaCrowdfund: finalize + _computeAllocation

**File**: `contracts/crowdfund/ArmadaCrowdfund.sol` (L222-307, L467-485)

### 6.1 finalize Purpose

Finalizes crowdfund after commitment window. Determines sale size (elastic expansion), computes per-hop reserves, processes sequential rollover, and transitions to Finalized/Canceled.

### 6.2 finalize Block-by-Block

- L223: `require(block.timestamp > commitmentEnd)` — timing gate
- L224-227: Phase guard — requires Invitation or Commitment (Commitment is unreachable dead code)
- L230-234: If `totalCommitted < MIN_SALE` ($1M), cancels sale
- L237-241: Elastic expansion — if `totalCommitted >= ELASTIC_TRIGGER` ($1.8M), saleSize = MAX_SALE
- L244-248: ARM sufficiency check
- L251-258: Per-hop reserve calculation from saleSize * reserveBps
- L261-284: Sequential rollover: under-subscribed hop leftover rolls to next hop (if committer threshold met)
- L292-303: Store finalReserves/finalDemands, compute hop-level totals (upper bounds)
- L302-306: Phase transition to Finalized

### 6.3 _computeAllocation (L467-485)

Lazy per-participant allocation using stored hop-level data:
- **Under-subscribed**: `allocUsdc = committed`, `allocArm = (committed * 1e18) / ARM_PRICE`
- **Over-subscribed**: `allocUsdc = (committed * finalReserves[hop]) / finalDemands[hop]`
- **Refund**: `refundUsdc = committed - allocUsdc` (exact)

### 6.4 Key Invariants

- **INV-FZ-1**: `sum(reserveBps) == 10000`, so `sum(reserves) == saleSize`
- **INV-FZ-2**: Post-rollover: `reserves + treasuryLeftover == saleSize`
- **INV-CA-1**: `allocUsdc + refundUsdc == committed` exactly (no rounding leakage to user)
- **INV-FZ-4**: Phase transitions are one-way (Invitation -> Finalized or Canceled)

### 6.5 Observations

- **Phase.Commitment dead code**: `commit()` at L187-L217 does NOT transition phase to Commitment. The guard at L225 checking `Phase.Commitment` is unreachable.
- **Integer division dust**: In over-subscribed hops, per-participant `allocUsdc` rounds down. Sum of all allocations may be less than `finalReserves[hop]`. Dust remains in contract.
- **No finalization deadline**: Admin can delay `finalize()` indefinitely after `commitmentEnd`, locking participant USDC.
- **ARM recovery after cancellation**: `withdrawUnallocatedArm()` requires `phase == Finalized`. If sale is canceled, ARM tokens are permanently locked.

---

## 7. Summary: Key Invariants Across All Functions

| ID | Invariant | Location |
|----|-----------|----------|
| INV-SM-1 | `base + fee == value` for all shield fee calculations | ShieldModule L265-L266 |
| INV-SM-3 | Balance check ensures exact token receipt | ShieldModule L234-L238 |
| INV-TM-1 | Nullifier uniqueness enforced before token transfers | TransactModule L315-L316 |
| INV-TM-2 | Two-pass architecture: nullify-all-then-transfer | TransactModule L51-L70 |
| INV-TM-4 | adaptContract binding enforced | TransactModule L241-L245 |
| INV-HF-1 | Only tokenMessenger can trigger cross-chain shield | PrivacyPool L169 |
| INV-HF-4 | Remote sender NOT validated on Hub | PrivacyPool L174-L177 |
| INV-LA-1 | SNARK proof binds adapter address and destination | ArmadaYieldAdapter L162, L169 |
| INV-LA-2 | adaptParams prevents destination change | ArmadaYieldAdapter L168-L176 |
| INV-RD-1 | `assets + yieldFee == grossAssets` | ArmadaYieldVault L281 |
| INV-RD-3 | totalPrincipal clamped to prevent underflow | ArmadaYieldVault L259-L262 |
| INV-FZ-1 | reserveBps sum to 10000 | ArmadaCrowdfund L105-L107 |
| INV-CA-1 | `allocUsdc + refundUsdc == committed` exactly | ArmadaCrowdfund L484 |

---

## 8. Open Questions Requiring Further Investigation

1. **Reentrancy in ShieldModule.shield**: No reentrancy guard on `shield()` or `_transferTokenIn()`. Safe for USDC but not for ERC777-like tokens.

2. **Missing sender/domain validation on Hub**: `handleReceiveFinalizedMessage` does not validate `sender` or `remoteDomain`. Trust model depends on CCTP's own authentication.

3. **Cost basis corruption via ERC20 transfer**: Vault shares transferred via `transfer()` have no cost basis update. Recipient pays 10% fee on entire value.

4. **Treasury as single point of failure**: If `IArmadaTreasury(treasury).recordFee` reverts, all yield redemptions are blocked.

5. **Amount from calldata in adapter**: `lendAndShield` reads amount from calldata preimage, not actual USDC balance. Depends on adapter maintaining privileged status.

6. **safeApprove without reset in TransactModule**: `_executeCCTPBurn` does not reset allowance to 0 first. Could block subsequent burns if prior approval wasn't fully consumed.

7. **Phase.Commitment unreachable**: The `commit()` function never sets `phase = Phase.Commitment`, making that branch in finalize() dead code.

8. **ARM token recovery after cancellation**: No mechanism to recover ARM in Canceled state.

9. **No finalization deadline**: Admin can indefinitely delay `finalize()`, locking participant USDC.

10. **Integer division dust in crowdfund**: Per-participant rounding in over-subscribed hops leaves USDC dust in contract.
