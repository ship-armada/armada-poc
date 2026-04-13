# Entry Point Analysis: Railgun CCTP POC

**Analyzed**: 2026-02-19
**Scope**: `contracts/` (full codebase)
**Languages**: Solidity 0.8.17
**Focus**: State-changing functions only (view/pure excluded)
**Method**: Slither `--print entry-points` + manual access control classification

## Summary

| Category | Count |
|----------|-------|
| Public (Unrestricted) | 22 |
| Role-Restricted | 12 |
| Admin / Owner | 28 |
| Governance (Timelock) | 6 |
| Contract-Only | 4 |
| Restricted (Review Required) | 3 |
| **Total** | **75** |

---

## Public Entry Points (Unrestricted)

State-changing functions callable by anyone --- prioritize for attack surface analysis.

### Privacy Pool (Core)
| Function | File | Notes |
|----------|------|-------|
| `shield(ShieldRequest[])` | `PrivacyPool.sol:103` | Delegates to ShieldModule. Transfers USDC in, creates commitments. |
| `transact(Transaction[])` | `PrivacyPool.sol:111` | Delegates to TransactModule. Nullifies inputs, creates outputs, unshields. |
| `atomicCrossChainUnshield(Transaction,uint32,address,bytes32,uint256)` | `PrivacyPool.sol:125` | Cross-chain unshield via CCTP. Burns USDC on hub, mints on client. |
| `crossChainShield(uint256,uint256,bytes32,bytes32[3],bytes32,bytes32)` | `PrivacyPoolClient.sol:113` | Burns USDC on client via CCTP, creates shield on hub. |

### Yield System
| Function | File | Notes |
|----------|------|-------|
| `lendAndShield(Transaction,bytes32,ShieldCiphertext)` | `ArmadaYieldAdapter.sol:153` | Atomic: unshield USDC -> deposit vault -> shield ayUSDC. nonReentrant. |
| `redeemAndShield(Transaction,bytes32,ShieldCiphertext)` | `ArmadaYieldAdapter.sol:232` | Atomic: unshield ayUSDC -> redeem vault -> shield USDC. nonReentrant. |
| `deposit(uint256,address)` | `ArmadaYieldVault.sol:195` | Deposit USDC, receive vault shares. nonReentrant. |
| `redeem(uint256,address,address)` | `ArmadaYieldVault.sol:236` | Redeem shares for USDC (10% yield fee). nonReentrant. |

### Governance
| Function | File | Notes |
|----------|------|-------|
| `lock(uint256)` | `VotingLocker.sol:50` | Lock ARM tokens for voting power. nonReentrant. |
| `unlock(uint256)` | `VotingLocker.sol:67` | Unlock ARM tokens. nonReentrant. |
| `queue(uint256)` | `ArmadaGovernor.sol:213` | Queue succeeded proposal to timelock. State-gated. |
| `execute(uint256)` | `ArmadaGovernor.sol:234` | Execute queued proposal. nonReentrant, payable. |

### Crowdfund
| Function | File | Notes |
|----------|------|-------|
| `claim()` | `ArmadaCrowdfund.sol:313` | Claim ARM + refund after finalization. Requires commitment. nonReentrant. |
| `refund()` | `ArmadaCrowdfund.sol:339` | Full refund if sale canceled. nonReentrant. |

### Treasury
| Function | File | Notes |
|----------|------|-------|
| `onTokenTransfer(address,uint256,bytes)` | `ArmadaTreasury.sol:88` | **FINDING**: Anyone can call --- inflates `totalCollected` tracking. |
| `recordFee(address,address,uint256)` | `ArmadaTreasury.sol:105` | **FINDING**: Anyone can call --- inflates `totalCollected` tracking. |
| `receive()` | `ArmadaTreasury.sol:117` | Accepts ETH. |
| `receive()` | `ArmadaTreasuryGov.sol:191` | Accepts ETH. |

### ERC20 (Inherited)
| Function | File | Notes |
|----------|------|-------|
| `transfer`, `approve`, `transferFrom`, `increaseAllowance`, `decreaseAllowance` | `ArmadaYieldVault.sol` (ERC20) | Standard ERC20 operations on vault share token. |
| `transfer`, `approve`, `transferFrom`, `increaseAllowance`, `decreaseAllowance` | `ArmadaToken.sol` (ERC20) | Standard ERC20 operations on ARM governance token. |

### Test/Dev Only
| Function | File | Notes |
|----------|------|-------|
| `drip()` | `Faucet.sol:40` | Faucet for test tokens. |
| `dripTo(address)` | `Faucet.sol:44` | Faucet for test tokens. |

---

## Role-Restricted Entry Points

### Proposer (Threshold: 0.1% of ARM supply locked)
| Function | File | Restriction |
|----------|------|-------------|
| `propose(ProposalType,address[],uint256[],bytes[],string)` | `ArmadaGovernor.sol:130` | `_checkProposalThreshold()` --- needs 0.1% of ARM locked |
| `cancel(uint256)` | `ArmadaGovernor.sol:250` | `require(msg.sender == p.proposer)` --- proposer only |

### Token Holder (Voting Power)
| Function | File | Restriction |
|----------|------|-------------|
| `castVote(uint256,uint8)` | `ArmadaGovernor.sol:187` | `require(weight > 0)` --- needs locked ARM at snapshot |

### Whitelisted Participant
| Function | File | Restriction |
|----------|------|-------------|
| `invite(address)` | `ArmadaCrowdfund.sol:153` | `require(inviter.isWhitelisted)` + time window + invite limit |
| `commit(uint256)` | `ArmadaCrowdfund.sol:187` | `require(p.isWhitelisted)` + time window + hop cap. nonReentrant. |

### Beneficiary
| Function | File | Restriction |
|----------|------|-------------|
| `exerciseClaim(uint256,uint256)` | `ArmadaTreasuryGov.sol:121` | `require(c.beneficiary == msg.sender)`. nonReentrant. |

### Steward
| Function | File | Restriction |
|----------|------|-------------|
| `proposeAction(address,bytes,uint256)` | `TreasurySteward.sol:103` | `onlySteward` + term not expired |
| `executeAction(uint256)` | `TreasurySteward.sol:124` | `onlySteward` + delay elapsed + not vetoed. nonReentrant. |
| `stewardSpend(address,address,uint256)` | `ArmadaTreasuryGov.sol:136` | `onlySteward` + monthly budget (1% of balance) |

### Permission-Based
| Function | File | Restriction |
|----------|------|-------------|
| `callContract(address,bytes,uint256)` | `Delegator.sol:75` | `permissions[msg.sender][_contract][_sig]` dynamic lookup |

---

## Admin / Owner Entry Points

### PrivacyPool Admin (`require(msg.sender == owner)`)
| Function | File | Notes |
|----------|------|-------|
| `setRemotePool(uint32,bytes32)` | `PrivacyPool.sol:232` | Configure client chain addresses |
| `setVerificationKey(uint256,uint256,VerifyingKey)` | `PrivacyPool.sol:244` | Set SNARK verification keys |
| `setShieldFee(uint120)` | `PrivacyPool.sol:260` | Set shield fee (max 10000 bps) |
| `setUnshieldFee(uint120)` | `PrivacyPool.sol:270` | Set unshield fee (max 10000 bps) |
| `setTreasury(address)` | `PrivacyPool.sol:280` | Set fee recipient |
| `setTestingMode(bool)` | `PrivacyPool.sol:291` | **CRITICAL**: Bypasses all SNARK verification |
| `setPrivilegedShieldCaller(address,bool)` | `PrivacyPool.sol:305` | Exempt address from fees |

### PrivacyPoolClient Admin
| Function | File | Notes |
|----------|------|-------|
| `setHubPool(uint32,bytes32)` | `PrivacyPoolClient.sol:257` | Reconfigure hub chain |

### Yield Admin
| Function | File | Notes |
|----------|------|-------|
| `setPrivacyPool(address)` | `ArmadaYieldAdapter.sol:113` | Link adapter to pool |
| `transferOwnership(address)` | `ArmadaYieldAdapter.sol:122` | Transfer adapter ownership |
| `rescueTokens(address,address,uint256)` | `ArmadaYieldAdapter.sol:325` | Emergency token rescue |
| `setTreasury(address)` | `ArmadaYieldVault.sol:162` | Set fee recipient |
| `setAdapter(address)` | `ArmadaYieldVault.sol:172` | Set privileged adapter |
| `transferOwnership(address)` | `ArmadaYieldVault.sol:181` | Transfer vault ownership |

### Treasury Admin
| Function | File | Notes |
|----------|------|-------|
| `withdraw(address,address,uint256)` | `ArmadaTreasury.sol:50` | Withdraw any token |
| `transferOwnership(address)` | `ArmadaTreasury.sol:64` | Transfer treasury ownership |

### Crowdfund Admin
| Function | File | Notes |
|----------|------|-------|
| `addSeeds(address[])` | `ArmadaCrowdfund.sol:113` | Add seed participants (week-1 window only) |
| `addSeed(address)` | `ArmadaCrowdfund.sol:120` | Add single seed (week-1 window only) |
| ~~`startInvitations()`~~ | ~~`ArmadaCrowdfund.sol:138`~~ | ~~Removed — invites and commits happen concurrently during Active phase~~ |
| `finalize()` | `ArmadaCrowdfund.sol:222` | Compute allocations or cancel. nonReentrant. |
| `withdrawProceeds(address)` | `ArmadaCrowdfund.sol:356` | Withdraw USDC proceeds to treasury |
| `withdrawUnallocatedArm(address)` | `ArmadaCrowdfund.sol:372` | Withdraw excess ARM tokens |

### Proxy/Legacy Admin
| Function | File | Notes |
|----------|------|-------|
| `transferProxyOwnership`, `upgrade`, `pause`, `unpause` | `ProxyAdmin.sol` | All `onlyOwner` |
| `setPermission(address,address,bytes4,bool)` | `Delegator.sol:44` | `onlyOwner` |

---

## Governance (Timelock-Controlled)

| Function | File | Restriction |
|----------|------|-------------|
| `distribute(address,address,uint256)` | `ArmadaTreasuryGov.sol:71` | `onlyOwner` (timelock) |
| `createClaim(address,address,uint256)` | `ArmadaTreasuryGov.sol:81` | `onlyOwner` (timelock) |
| `setSteward(address)` | `ArmadaTreasuryGov.sol:104` | `onlyOwner` (timelock) |
| `transferOwnership(address)` | `ArmadaTreasuryGov.sol:110` | `onlyOwner` (timelock) |
| `electSteward(address)` | `TreasurySteward.sol:67` | `onlyTimelock` |
| `removeSteward()`, `vetoAction(uint256)`, `setActionDelay(uint256)` | `TreasurySteward.sol` | `onlyTimelock` |

---

## Contract-Only (Internal Integration Points)

| Function | File | Expected Caller |
|----------|------|-----------------|
| `handleReceiveFinalizedMessage(uint32,bytes32,uint32,bytes)` | `PrivacyPool.sol:161` | TokenMessenger only (`require(msg.sender == tokenMessenger)`) |
| `handleReceiveFinalizedMessage(uint32,bytes32,uint32,bytes)` | `PrivacyPoolClient.sol:184` | TokenMessenger only |
| `insertLeaves(bytes32[])` | `PrivacyPool.sol:407` | Self only (`require(msg.sender == address(this))`) |
| `handleReceiveUnfinalizedMessage(...)` | Both PrivacyPool + Client | Always reverts (not supported) |

---

## Restricted (Review Required)

Functions with access control patterns that need manual verification.

| Function | File | Pattern | Why Review |
|----------|------|---------|------------|
| `initialize(...)` | `PrivacyPool.sol:53` | `require(!initialized)` | One-shot initializer. No modifier --- front-running risk on deployment if not deployed atomically. |
| `initialize(...)` | `PrivacyPoolClient.sol:67` | `require(!initialized)` | Same front-running risk as above. |
| `callContract(address,bytes,uint256)` | `Delegator.sol:75` | `permissions[msg.sender][_contract][_sig]` | Dynamic permission map --- review who can set permissions. |

---

## Critical Findings from Entry Point Analysis

### HIGH: `setTestingMode(bool)` --- PrivacyPool.sol:291
- **Risk**: Owner can bypass ALL SNARK proof verification at any time
- **Impact**: Complete privacy pool compromise --- anyone could fabricate transactions
- **Note**: Documented as "POC ONLY" but present in deployed code

### HIGH: `VERIFICATION_BYPASS` in `verify()` --- PrivacyPool.sol:378
- **Risk**: `tx.origin == address(0)` during gas estimation always returns true
- **Impact**: Potential exploit vector if eth_estimateGas results are trusted for verification

### MEDIUM: `recordFee()` / `onTokenTransfer()` --- ArmadaTreasury.sol:88,105
- **Risk**: No access control --- anyone can call to inflate `totalCollected` tracking
- **Impact**: Corrupted fee accounting (tracking only, no fund loss)

### MEDIUM: Initializer front-running --- PrivacyPool.sol:53, PrivacyPoolClient.sol:67
- **Risk**: `initialize()` has no deployer check --- can be front-run on deployment
- **Impact**: Attacker could initialize with malicious parameters

### ~~LOW: Crowdfund phase transition has no `inPhase(Phase.Commitment)` gate~~ [RESOLVED]
- ~~**Risk**: `finalize()` checks `phase == Invitation || phase == Phase.Commitment`~~
- ~~**Impact**: Could finalize directly from Invitation phase~~
- **Resolution**: Phase model simplified to Active → Finalized/Canceled. Separate Invitation/Commitment phases removed; `finalize()` now checks `phase == Phase.Active`.

---

## Files Analyzed

| File | State-Changing Entry Points |
|------|----------------------------|
| `contracts/privacy-pool/PrivacyPool.sol` | 12 |
| `contracts/privacy-pool/PrivacyPoolClient.sol` | 4 |
| `contracts/privacy-pool/modules/ShieldModule.sol` | 2 (via delegatecall) |
| `contracts/privacy-pool/modules/TransactModule.sol` | 2 (via delegatecall) |
| `contracts/privacy-pool/modules/MerkleModule.sol` | 2 (via delegatecall) |
| `contracts/yield/ArmadaYieldAdapter.sol` | 5 |
| `contracts/yield/ArmadaYieldVault.sol` | 8 |
| `contracts/yield/ArmadaTreasury.sol` | 5 |
| `contracts/governance/ArmadaGovernor.sol` | 6 |
| `contracts/governance/VotingLocker.sol` | 2 |
| `contracts/governance/ArmadaTreasuryGov.sol` | 7 |
| `contracts/governance/TreasurySteward.sol` | 6 |
| `contracts/governance/ArmadaToken.sol` | 5 |
| `contracts/crowdfund/ArmadaCrowdfund.sol` | 10 |
| `contracts/Faucet.sol` | 2 |
| `contracts/railgun/governance/Delegator.sol` | 3 |
| `contracts/railgun/proxy/ProxyAdmin.sol` | 5 |
| `contracts/railgun/proxy/Proxy.sol` | 4 |
