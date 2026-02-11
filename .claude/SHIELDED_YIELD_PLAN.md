# Shielded Yield Implementation Plan (Trustless Design)

## Overview

Enable users to deposit/withdraw to the yield vault directly from their shielded balance using a **trustless** atomic flow leveraging Railgun's adapt contract pattern.

**Goal**: Shielded USDC ↔ Shielded ayUSDC with no trust in the adapter.

## Trust Model

### How Trustlessness is Achieved

Railgun's `adaptContract` and `adaptParams` mechanism ensures the adapter cannot deviate from user intent:

```
User's Proof Commits To:
┌─────────────────────────────────────────────────────────────┐
│  boundParams.adaptContract = YieldAdapter address           │
│  boundParams.adaptParams = hash(npk, encryptedBundle, ...)  │
│                                                             │
│  This is VERIFIED by the SNARK proof on-chain!              │
└─────────────────────────────────────────────────────────────┘

Result:
- Only YieldAdapter can submit this transaction (adaptContract check)
- YieldAdapter MUST use the committed shield parameters (adaptParams check)
- If adapter tries to shield to different npk → adaptParams mismatch → REVERT
```

| Component | Trust Required | Why |
|-----------|----------------|-----|
| User | None | Generates proof locally, controls parameters |
| Adapter | **None** | Bound by adaptParams - cannot deviate from proof |
| PrivacyPool | Trusted (audited) | Verifies proofs, enforces adaptContract/adaptParams |
| Vault | Trusted (audited) | Standard ERC-4626 vault |

## Architecture

```
Lend Flow (shielded USDC → shielded ayUSDC):

┌─────────────────────────────────────────────────────────────────────────┐
│                         User's Browser                                  │
│                                                                         │
│  1. Generate unshield proof for USDC with:                              │
│     - unshieldPreimage.npk = adapter address (to receive USDC)          │
│     - boundParams.adaptContract = YieldAdapter                          │
│     - boundParams.adaptParams = hash(userNpk, shieldCiphertext)         │
│                                                                         │
│  2. Build shield request for ayUSDC (userNpk, ciphertext)               │
│                                                                         │
│  3. Call YieldAdapter.lendAndShield(transaction, shieldRequest)         │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         YieldAdapter Contract                           │
│                                                                         │
│  function lendAndShield(Transaction tx, ShieldRequest req):             │
│                                                                         │
│    // 1. Verify adaptParams matches shield request                      │
│    require(tx.boundParams.adaptParams == hash(req))                     │
│                                                                         │
│    // 2. Execute unshield (PrivacyPool verifies proof)                  │
│    //    - Checks adaptContract == msg.sender (this adapter) ✓          │
│    //    - Verifies SNARK proof ✓                                       │
│    //    - Transfers USDC to this contract                              │
│    privacyPool.transact([tx])                                           │
│                                                                         │
│    // 3. Deposit USDC to vault                                          │
│    shares = vault.deposit(amount, address(this))                        │
│                                                                         │
│    // 4. Shield ayUSDC to user's npk (from bound params)                │
│    //    - npk came from user's proof commitment                        │
│    //    - Adapter cannot change it without failing adaptParams check   │
│    privacyPool.shield([{npk: req.npk, token: vault, value: shares}])    │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

## Implementation Phases

### Phase 1: Contract Updates

#### 1.1 Create YieldAdaptParams Library

```solidity
// contracts/yield/YieldAdaptParams.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

/**
 * @title YieldAdaptParams
 * @notice Encoding/decoding for yield adapter bound parameters
 * @dev The adaptParams field in a transaction binds the re-shield destination
 *      This ensures the adapter cannot shield to a different recipient
 */
library YieldAdaptParams {
    /**
     * @notice Encode yield operation parameters into adaptParams
     * @param npk Note public key for re-shielding
     * @param encryptedBundle Shield ciphertext [3]
     * @param shieldKey Shield public key
     * @return adaptParams Hash of all parameters
     */
    function encode(
        bytes32 npk,
        bytes32[3] memory encryptedBundle,
        bytes32 shieldKey
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(npk, encryptedBundle, shieldKey));
    }

    /**
     * @notice Verify that shield request matches the bound adaptParams
     * @param adaptParams The bound parameters from the transaction
     * @param npk Note public key from shield request
     * @param encryptedBundle Shield ciphertext from shield request
     * @param shieldKey Shield public key from shield request
     */
    function verify(
        bytes32 adaptParams,
        bytes32 npk,
        bytes32[3] memory encryptedBundle,
        bytes32 shieldKey
    ) internal pure returns (bool) {
        return adaptParams == encode(npk, encryptedBundle, shieldKey);
    }
}
```

#### 1.2 Update ArmadaYieldAdapter.sol

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "../privacy-pool/interfaces/IPrivacyPool.sol";
import "../railgun/logic/Globals.sol";
import "./YieldAdaptParams.sol";

interface IArmadaYieldVault {
    function deposit(uint256 assets, address receiver) external returns (uint256 shares);
    function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets);
}

/**
 * @title ArmadaYieldAdapter
 * @notice Trustless adapter for shielded yield operations
 * @dev Uses Railgun's adaptContract pattern for trustless execution:
 *      - User's proof binds adaptContract to this adapter
 *      - User's proof binds adaptParams to the re-shield parameters
 *      - Adapter verifies adaptParams match before executing
 *      - Adapter CANNOT deviate from user's committed parameters
 */
contract ArmadaYieldAdapter is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ============ Immutables ============

    IERC20 public immutable usdc;
    IArmadaYieldVault public immutable vault;
    IERC20 public immutable shareToken;
    IPrivacyPool public immutable privacyPool;

    // ============ Events ============

    event LendAndShield(
        bytes32 indexed npk,
        uint256 usdcAmount,
        uint256 sharesMinted
    );

    event RedeemAndShield(
        bytes32 indexed npk,
        uint256 sharesBurned,
        uint256 usdcRedeemed
    );

    // ============ Constructor ============

    constructor(
        address _usdc,
        address _vault,
        address _privacyPool
    ) {
        require(_usdc != address(0), "zero usdc");
        require(_vault != address(0), "zero vault");
        require(_privacyPool != address(0), "zero privacyPool");

        usdc = IERC20(_usdc);
        vault = IArmadaYieldVault(_vault);
        shareToken = IERC20(_vault);
        privacyPool = IPrivacyPool(_privacyPool);

        // Approve vault to spend USDC
        usdc.approve(_vault, type(uint256).max);
    }

    // ============ Trustless Yield Operations ============

    /**
     * @notice Atomic lend: unshield USDC → deposit → shield ayUSDC
     * @dev Trustless: adaptParams in proof binds the re-shield destination
     *
     * User must generate proof with:
     *   - boundParams.adaptContract = address(this)
     *   - boundParams.adaptParams = YieldAdaptParams.encode(npk, encryptedBundle, shieldKey)
     *   - unshieldPreimage.npk = address(this) (receives USDC)
     *
     * @param _transaction Unshield transaction (proof verified by PrivacyPool)
     * @param _shieldCiphertext Ciphertext for re-shielding ayUSDC
     * @return shares Amount of ayUSDC shares minted
     */
    function lendAndShield(
        Transaction calldata _transaction,
        ShieldCiphertext calldata _shieldCiphertext
    ) external nonReentrant returns (uint256 shares) {
        // 1. Verify this is an adapt transaction for this contract
        require(
            _transaction.boundParams.adaptContract == address(this),
            "Invalid adaptContract"
        );

        // 2. Extract the npk from the transaction's unshield preimage
        //    This npk is where ayUSDC will be shielded to
        //    It's committed in the proof via adaptParams
        bytes32 userNpk = _transaction.unshieldPreimage.npk;

        // Wait, the unshield npk is where USDC goes (this adapter)
        // The user's npk for re-shielding must be in adaptParams
        // Let me reconsider...

        // Actually, for unshield: npk = recipient address (adapter)
        // For re-shield: npk = user's note public key
        // The user's re-shield npk must be encoded in adaptParams

        // We need to decode it from adaptParams or pass it explicitly
        // Let's pass it explicitly and verify against adaptParams

        // 3. Verify adaptParams matches the provided shield data
        //    This ensures user committed to these exact re-shield parameters
        bytes32 npk = _extractNpkFromCiphertext(_shieldCiphertext);
        require(
            YieldAdaptParams.verify(
                _transaction.boundParams.adaptParams,
                npk,
                _shieldCiphertext.encryptedBundle,
                _shieldCiphertext.shieldKey
            ),
            "adaptParams mismatch"
        );

        // 4. Execute unshield - PrivacyPool verifies proof and sends USDC here
        Transaction[] memory txs = new Transaction[](1);
        txs[0] = _transaction;
        privacyPool.transact(txs);

        // 5. Get the amount from unshield preimage
        uint256 amount = _transaction.unshieldPreimage.value;
        require(amount > 0, "zero amount");

        // 6. Deposit USDC to vault
        shares = vault.deposit(amount, address(this));

        // 7. Build and execute shield request for ayUSDC
        ShieldRequest[] memory shieldRequests = new ShieldRequest[](1);
        shieldRequests[0] = ShieldRequest({
            preimage: CommitmentPreimage({
                npk: npk,  // User's npk from verified adaptParams
                token: TokenData({
                    tokenType: TokenType.ERC20,
                    tokenAddress: address(shareToken),
                    tokenSubID: 0
                }),
                value: uint120(shares)
            }),
            ciphertext: _shieldCiphertext
        });

        shareToken.approve(address(privacyPool), shares);
        privacyPool.shield(shieldRequests);

        emit LendAndShield(npk, amount, shares);
    }

    /**
     * @notice Atomic redeem: unshield ayUSDC → redeem → shield USDC
     * @dev Trustless: adaptParams in proof binds the re-shield destination
     *
     * @param _transaction Unshield transaction for ayUSDC
     * @param _shieldCiphertext Ciphertext for re-shielding USDC
     * @return assets Amount of USDC redeemed (after yield fee)
     */
    function redeemAndShield(
        Transaction calldata _transaction,
        ShieldCiphertext calldata _shieldCiphertext
    ) external nonReentrant returns (uint256 assets) {
        // 1. Verify this is an adapt transaction for this contract
        require(
            _transaction.boundParams.adaptContract == address(this),
            "Invalid adaptContract"
        );

        // 2. Extract and verify npk from adaptParams
        bytes32 npk = _extractNpkFromCiphertext(_shieldCiphertext);
        require(
            YieldAdaptParams.verify(
                _transaction.boundParams.adaptParams,
                npk,
                _shieldCiphertext.encryptedBundle,
                _shieldCiphertext.shieldKey
            ),
            "adaptParams mismatch"
        );

        // 3. Execute unshield - PrivacyPool verifies proof and sends ayUSDC here
        Transaction[] memory txs = new Transaction[](1);
        txs[0] = _transaction;
        privacyPool.transact(txs);

        // 4. Get the shares from unshield preimage
        uint256 shares = _transaction.unshieldPreimage.value;
        require(shares > 0, "zero shares");

        // 5. Redeem ayUSDC for USDC (10% yield fee applied by vault)
        shareToken.approve(address(vault), shares);
        assets = vault.redeem(shares, address(this), address(this));

        // 6. Build and execute shield request for USDC
        ShieldRequest[] memory shieldRequests = new ShieldRequest[](1);
        shieldRequests[0] = ShieldRequest({
            preimage: CommitmentPreimage({
                npk: npk,  // User's npk from verified adaptParams
                token: TokenData({
                    tokenType: TokenType.ERC20,
                    tokenAddress: address(usdc),
                    tokenSubID: 0
                }),
                value: uint120(assets)
            }),
            ciphertext: _shieldCiphertext
        });

        usdc.approve(address(privacyPool), assets);
        privacyPool.shield(shieldRequests);

        emit RedeemAndShield(npk, shares, assets);
    }

    // ============ Internal ============

    /**
     * @notice Extract npk from shield ciphertext
     * @dev The npk is derived during proof generation and encoded in ciphertext
     *      For simplicity in POC, we pass npk separately and verify via adaptParams
     */
    function _extractNpkFromCiphertext(
        ShieldCiphertext calldata /* _ciphertext */
    ) internal pure returns (bytes32) {
        // In production: decode npk from encrypted bundle
        // For POC: npk is passed in adaptParams and verified there
        // This function would decrypt/extract the npk
        revert("Not implemented - use explicit npk parameter");
    }
}
```

**Wait** - I realize there's a design issue. The shield ciphertext encrypts data for the recipient, but the npk itself needs to be explicit for the contract to use. Let me refine:

#### 1.3 Refined Adapter Design

```solidity
/**
 * @notice Atomic lend with explicit npk parameter
 * @param _transaction Unshield transaction
 * @param _npk User's note public key for re-shielding
 * @param _shieldCiphertext Ciphertext for recipient to decrypt
 */
function lendAndShield(
    Transaction calldata _transaction,
    bytes32 _npk,
    ShieldCiphertext calldata _shieldCiphertext
) external nonReentrant returns (uint256 shares) {
    // Verify adaptContract
    require(
        _transaction.boundParams.adaptContract == address(this),
        "Invalid adaptContract"
    );

    // Verify adaptParams binds the npk and ciphertext
    require(
        YieldAdaptParams.verify(
            _transaction.boundParams.adaptParams,
            _npk,
            _shieldCiphertext.encryptedBundle,
            _shieldCiphertext.shieldKey
        ),
        "adaptParams mismatch"
    );

    // Execute unshield
    Transaction[] memory txs = new Transaction[](1);
    txs[0] = _transaction;
    privacyPool.transact(txs);

    // Deposit to vault
    uint256 amount = _transaction.unshieldPreimage.value;
    shares = vault.deposit(amount, address(this));

    // Shield ayUSDC to user
    ShieldRequest[] memory req = new ShieldRequest[](1);
    req[0] = ShieldRequest({
        preimage: CommitmentPreimage({
            npk: _npk,
            token: TokenData(TokenType.ERC20, address(shareToken), 0),
            value: uint120(shares)
        }),
        ciphertext: _shieldCiphertext
    });

    shareToken.approve(address(privacyPool), shares);
    privacyPool.shield(req);

    emit LendAndShield(_npk, amount, shares);
}
```

### Phase 2: Frontend Updates

#### 2.1 Update Proof Generation

The Railgun SDK needs to generate proofs with adaptContract and adaptParams:

```typescript
// In shieldedYield service

import { YieldAdaptParams } from './yieldAdaptParams'

async function generateLendProof(
  walletId: string,
  encryptionKey: string,
  amount: bigint,
  adapterAddress: string,
  userNpk: bytes32,
  shieldCiphertext: ShieldCiphertext
): Promise<Transaction> {
  // Calculate adaptParams (must match what adapter verifies)
  const adaptParams = YieldAdaptParams.encode(
    userNpk,
    shieldCiphertext.encryptedBundle,
    shieldCiphertext.shieldKey
  )

  // Generate unshield proof with adapt contract binding
  const proof = await generateUnshieldProofWithAdapt(
    walletId,
    encryptionKey,
    {
      tokenAddress: usdcAddress,
      amount,
      recipientAddress: adapterAddress,  // USDC goes to adapter
    },
    adapterAddress,  // boundParams.adaptContract
    adaptParams,     // boundParams.adaptParams (binds re-shield destination)
  )

  return proof
}
```

#### 2.2 SDK Extension Required

The Railgun SDK's `generateUnshieldProof` may need extension to support adaptContract/adaptParams. Check if this is already supported:

```typescript
// Need to verify SDK supports this or we need to modify:
await generateUnshieldProof(
  TXIDVersion.V2_PoseidonMerkle,
  networkName,
  walletId,
  encryptionKey,
  recipients,
  [],
  undefined,
  true,
  undefined,
  progressCallback,
  // Additional params needed:
  adaptContract,  // address
  adaptParams,    // bytes32
)
```

### Phase 3: Deployment Updates

Update deployment script to:
1. Deploy new adapter with PrivacyPool address
2. No special permissions needed (adapter uses public functions)

### Phase 4: Testing

1. **Trustlessness Test**
   - Generate proof with adaptParams = hash(userNpk, ciphertext)
   - Try calling adapter with different npk → should revert
   - Try calling adapter with different ciphertext → should revert

2. **Happy Path Test**
   - Generate proof with correct adaptParams
   - Call adapter.lendAndShield() → success
   - Verify ayUSDC shielded to correct npk

## Key Differences from Original Plan

| Aspect | Original (Trusted) | New (Trustless) |
|--------|-------------------|-----------------|
| Adapter trust | Must trust adapter code | Zero trust - bound by proof |
| npk binding | Adapter receives npk as parameter | npk committed in proof via adaptParams |
| Attack vector | Adapter could shield to wrong address | Impossible - would fail adaptParams check |
| Proof structure | Standard unshield | Unshield with adaptContract + adaptParams |

## Open Questions

1. **SDK Support**: Does Railgun SDK support adaptContract/adaptParams in proof generation?
   - If yes: Use existing SDK
   - If no: Need to extend SDK or use lower-level primitives

2. **Fee Exemption**: Protocol fee on the unshield/shield operations
   - For POC: Accept standard fees
   - For production: Whitelist adapter for fee exemption

3. **Principal Tracking**: How does the vault track principal when adapter is the depositor?
   - Current vault uses `userPrincipal[owner]`
   - Need to pass through user identifier or track at adapter level
