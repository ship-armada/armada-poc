# Armada Privacy Pool — Contract Behavior Specification

**Status:** Phase 0 clean-room rewrite specification
**Audience:** Implementer rewriting the privacy pool contract system from scratch (without access to any legacy or third-party unlicensed source)
**Companion document:** `specs/CONTRACT_REWRITE_DEVIATIONS.md` (provenance & intentional-deviation register — the only place legacy-system naming may appear)

> **How this document was produced.** Every fact below is a *behavioral* fact extracted from Armada's own deployed-source tree (`contracts/privacy-pool/`), from Armada's circuit specification (`armada-circuits/docs/SPEC.md`, `docs/PRIMITIVES.md`), and from Armada's formal fee model (`armada-lean/ArmadaLean/Fee.lean`). Prose was rewritten from scratch. An implementer following this document should never need to open any file outside the rewrite workspace.

> **Conformance language.** "MUST / MUST NOT / SHOULD" are normative. Anything marked **OQ-n** is an open question pending a team decision (§13) — implement to the *current* behavior described, but flag the call site.

---

## 1. System Architecture

### 1.1 Components

| Component | Role | Holds state? |
|---|---|---|
| `PrivacyPool` ("router") | Sole state-holding contract and sole external entry point on the Hub chain | **Yes** — all state |
| `ShieldModule` | Logic for local shields and inbound cross-chain shields | No (executes via `delegatecall`) |
| `TransactModule` | Logic for private transfers, local unshields, atomic cross-chain unshields | No |
| `MerkleModule` | Incremental binary Poseidon Merkle tree logic | No |
| `VerifierModule` | SNARK verification-key registry and proof verification logic | No |
| `PrivacyPoolStorage` | Abstract base contract defining the **shared storage layout**; inherited by the router **and every module** so `delegatecall` reads/writes the router's slots correctly | Layout only |

Out of scope for this document: `PrivacyPoolClient` (client-chain contract), CCTP mock/router contracts, the fee module implementation, and governance contracts. Their *interfaces* as consumed by this system are specified in §10.

### 1.2 Dispatch model

- The router holds all state. Every user-facing operation is forwarded to a module via **`delegatecall`** (see §5.4 for the exact forwarding/bubbling rules). Module addresses are set once in `initialize` and are **not upgradeable** thereafter (no setter exists).
- Every externally reachable module function carries an `onlyDelegatecall` guard: each module stores its own address in an `immutable` variable (`_self = address(this)`) at deploy time, and the guard requires `address(this) != _self`. Under `delegatecall`, `address(this)` is the router, so the check passes; a direct call to the module reverts with `"PrivacyPoolStorage: Direct call not allowed"`.
- **Intra-operation module-to-module calls** go through the router by calling `address(this)` with the module interface:
  - `ShieldModule`/`TransactModule` call `IMerkleModule(address(this)).insertLeaves(...)` → the router's own `insertLeaves` requires `msg.sender == address(this)` (`"Only self"`) and then `delegatecall`s `MerkleModule`.
  - The same pattern is used for `getInsertionTreeNumberAndStartingIndex` (served by a **view function implemented directly on the router**, §5.3) and for `verify` (also implemented directly on the router, §5.3 — see **OQ-2**).

### 1.3 Caller / authorization matrix

| Function | Caller constraint |
|---|---|
| `initialize` | Permissionless, exactly once (first call wins) — **OQ-7** |
| `shield`, `transact`, `atomicCrossChainUnshield` | Permissionless |
| `handleReceiveFinalizedMessage`, `handleReceiveUnfinalizedMessage` | `msg.sender == hookRouter` **or** `msg.sender == tokenMessenger` |
| All admin setters (§5.2) | `msg.sender == owner` |
| `insertLeaves` (router) | `msg.sender == address(this)` (self-call only) |
| `verify`, `getVerificationKey`, `getInsertionTreeNumberAndStartingIndex` | Permissionless views |
| Every module external function | `onlyDelegatecall` (reachable only through the router) |

`owner` is a single `address` set at `initialize`. There is **no** ownership-transfer or renounce function.

---

## 2. Constants and Cryptographic Primitives

| Name | Value | Notes |
|---|---|---|
| `SNARK_SCALAR_FIELD` | `21888242871839275222246405745257275088548364400416034343698204186575808495617` | BN254 scalar field order. All field-valued inputs must be `<` this. |
| `VERIFICATION_BYPASS` | `0x000000000000000000000000000000000000dEaD` | If `tx.origin` equals this address, `verify` returns `true` (gas-estimation escape hatch — **OQ-4**). |
| `ZERO_VALUE` | `0x0488f89b25bc7011eaf6a5edce71aeafb9fe706faa3c0a5cd9cbe868ae3b9ffc` (decimal `2051258411002736885948763699317990061539314419500486054347250703186609807356`) | Level-0 zero leaf of the Merkle tree. **This exact value is a consensus fact** — the tree's empty root and every zero node derive from it. Its derivation is recorded in the deviation register (D-1); the rewrite MUST hard-code the value above. |
| `TREE_DEPTH` | `16` | Binary tree; 65,536 (`2**16`) leaves per tree. |
| `BASIS_POINTS` | `10000` | Fee denominator (module-private constant in ShieldModule). |
| `CCTPFinality.FAST` | `1000` (uint32) | CCTP V2 "confirmed" finality threshold. |
| `CCTPFinality.STANDARD` | `2000` (uint32) | CCTP V2 "finalized" finality threshold. |

### 2.1 Hash functions

- **Poseidon over BN254 scalar field**, circomlib parameters (α = 5). Two arities are used, exposed as bytecode-deployed libraries:
  - `PoseidonT3.poseidon(bytes32[2])` — 2-input hash (t = 3): Merkle node hash, nullifier, NPK components.
  - `PoseidonT4.poseidon(bytes32[3])` — 3-input hash (t = 4): commitment hash.
- `keccak256` is used only for `boundParamsHash`, non-ERC20 token IDs, and the (now hard-coded) `ZERO_VALUE` constant.

### 2.2 Formulas (pinned; must match the circuits exactly)

```
tokenID(tokenData)        = bytes32(uint256(uint160(tokenAddress)))                                   if tokenType == ERC20
                          = bytes32(uint256(keccak256(abi.encode(tokenData))) % SNARK_SCALAR_FIELD)   otherwise (ERC721/ERC1155 — currently unreachable, §13 OQ-6)

commitmentHash(preimage)  = PoseidonT4.poseidon([npk, tokenID(token), bytes32(uint256(value))])

boundParamsHash(bp)       = uint256(keccak256(abi.encode(bp))) % SNARK_SCALAR_FIELD
                            where abi.encode uses the standard ABI encoding of the BoundParams struct
                            (§3), including its dynamic CommitmentCiphertext[] tail

merkleNode(left, right)   = PoseidonT3.poseidon([left, right])

nullifier                 = Poseidon(nullifyingKey, leafIndex)              (circuit-side fact)
npk                       = Poseidon(Poseidon(spendingPublicKey[0], spendingPublicKey[1], nullifyingKey), random)   (circuit-side fact)
```

Reference: `armada-circuits/docs/PRIMITIVES.md` (confirmed against captured test vectors 2026-06-30) and `armada-circuits/docs/SPEC.md`.

### 2.3 SNARK public input layout

For a transaction with `N` nullifiers and `M` commitments, the public input vector has length `2 + N + M`:

```
inputs[0]                = uint256(merkleRoot)
inputs[1]                = boundParamsHash(boundParams)
inputs[2 + i]            = uint256(nullifiers[i])          for i in [0, N)
inputs[2 + N + j]        = uint256(commitments[j])         for j in [0, M)
```

The verifying key is selected by the pair `(N, M)` (§9). The circuit shapes in the initial registered set are defined in `armada-circuits/docs/SPEC.md` §"Operation Matrix" ((1,1), (1,2), (2,2), (2,3), (N,1) consolidations, (1,3), (3,3), (4,3), (3,2)–(6,2), (8,4)).

### 2.4 Fee formulas

- **Flat shield fee (inclusive)** — used when `feeModule == address(0)`, the caller is not privileged, and `shieldFee > 0`:
  ```
  fee  = (amount * shieldFee) / 10000        // integer floor division
  base = amount - fee
  ```
  This is the function modeled and proven in `armada-lean/ArmadaLean/Fee.lean` (`shieldFee`, `shieldBase`; theorems: boundedness at any rate ≤ 10000 bps, exact conservation `base + fee = amount`, monotonicity, zero-fee below 200 base units at 50 bps, and `shieldFee 50 amount = amount / 200`). The Lean file is the **normative reference** for rounding behavior.
- **Exclusive variant** (`base = amount`, `fee = (10000 * amount) / (10000 - feeBP) - amount`): present in the code but **never invoked** by any live path (**OQ-5**).
- **Fee-module path** — when `feeModule != address(0)`: `(armadaTake, integratorFee, totalFee) = IArmadaFeeModule(feeModule).calculateShieldFee(integrator, amount)`; `base = amount - totalFee`. Tiering/integrator economics: `specs/FEE_STRUCTURE.md`.
- **Unshields are always free** (fee constant 0; see deviation register D-2).

---

## 3. Data Types

All types below are ABI-pinned. Field names, types, and **order** MUST be preserved exactly; they determine calldata encoding, event encoding, `boundParamsHash`, and function selectors.

```solidity
enum TokenType { ERC20, ERC721, ERC1155 }              // uint8: 0, 1, 2
enum UnshieldType { NONE, NORMAL, REDIRECT }           // uint8: 0, 1, 2

struct G1Point { uint256 x; uint256 y; }
struct G2Point { uint256[2] x; uint256[2] y; }         // FQ2 element encoding: X[0] * z + X[1]
struct SnarkProof { G1Point a; G2Point b; G1Point c; } // Groth16 proof

struct VerifyingKey {
    string artifactsIPFSHash;   // informational; not used by verification logic
    G1Point alpha1;
    G2Point beta2;
    G2Point gamma2;
    G2Point delta2;
    G1Point[] ic;               // length must equal (#public inputs + 1) for the circuit shape
}

struct TokenData {
    TokenType tokenType;
    address tokenAddress;
    uint256 tokenSubID;
}

struct CommitmentPreimage {
    bytes32 npk;        // note public key; for unshield outputs this field encodes the recipient address
    TokenData token;
    uint120 value;
}

struct ShieldCiphertext {
    bytes32[3] encryptedBundle;
    bytes32 shieldKey;
}

struct ShieldRequest {
    CommitmentPreimage preimage;
    ShieldCiphertext ciphertext;
}

struct CommitmentCiphertext {
    bytes32[4] ciphertext;
    bytes32 blindedSenderViewingKey;
    bytes32 blindedReceiverViewingKey;
    bytes annotationData;
    bytes memo;
}

struct BoundParams {
    uint16 treeNumber;
    uint72 minGasPrice;
    UnshieldType unshield;
    uint64 chainID;
    address adaptContract;
    bytes32 adaptParams;
    CommitmentCiphertext[] commitmentCiphertext;
}

struct Transaction {
    SnarkProof proof;
    bytes32 merkleRoot;
    bytes32[] nullifiers;
    bytes32[] commitments;
    BoundParams boundParams;
    CommitmentPreimage unshieldPreimage;
}
```

CCTP payload types (`contracts/privacy-pool/types/`, Armada-native):

```solidity
enum MessageType { SHIELD, UNSHIELD }                  // uint8: 0, 1

struct CCTPPayload { MessageType messageType; bytes data; }

struct ShieldData {            // Client → Hub, abi-encoded into CCTPPayload.data
    bytes32 npk;
    uint120 value;             // gross amount burned on the client chain
    bytes32[3] encryptedBundle;
    bytes32 shieldKey;
    address integrator;
}

struct UnshieldData {          // Hub → Client
    address recipient;
}
```

Encoding helpers: `CCTPPayload = abi.encode((messageType, abi.encode(ShieldData|UnshieldData)))`.

---

## 4. Storage Layout (hard compatibility constraint)

Defined in `PrivacyPoolStorage` and inherited identically by the router and all four modules. **Slot assignments are frozen.** Compiler-verified layout (solc 0.8.17):

| Slot | Offset | Bytes | Name | Type | Visibility |
|---:|---:|---:|---|---|---|
| 0 | 0 | 20 | `shieldModule` | `address` | public |
| 1 | 0 | 20 | `transactModule` | `address` | public |
| 2 | 0 | 20 | `merkleModule` | `address` | public |
| 3 | 0 | 20 | `verifierModule` | `address` | public |
| 4 | 0 | 20 | `tokenMessenger` | `address` | public |
| 5 | 0 | 20 | `messageTransmitter` | `address` | public |
| 6 | 0 | 20 | `usdc` | `address` | public |
| 6 | 20 | 4 | `localDomain` | `uint32` | public |
| 7 | — | — | `remotePools` | `mapping(uint32 => bytes32)` | public |
| 8 | 0 | 20 | `treasury` | `address payable` | public |
| 9 | 0 | 15 | `shieldFee` | `uint120` | public |
| 9 | 15 | 15 | `unshieldFee` | `uint120` (deprecated, always 0) | public |
| 10 | 0 | 15 | `nftFee` | `uint120` (unused, always 0) | public |
| 11 | — | — | `privilegedShieldCallers` | `mapping(address => bool)` | public |
| 12 | — | — | `tokenBlocklist` | `mapping(address => bool)` | public |
| 13 | — | — | `tokenIDMapping` | `mapping(bytes32 => TokenData)` | public (unused by live paths) |
| 14 | 0 | 32 | `nextLeafIndex` | `uint256` | public |
| 15 | 0 | 32 | `merkleRoot` | `bytes32` | public |
| 16 | 0 | 32 | `newTreeRoot` | `bytes32` (cached empty-tree root) | internal |
| 17 | 0 | 32 | `treeNumber` | `uint256` | public |
| 18–33 | 0 | 512 | `zeros` | `bytes32[16]` | public |
| 34–49 | 0 | 512 | `filledSubTrees` | `bytes32[16]` | internal |
| 50 | — | — | `rootHistory` | `mapping(uint256 => mapping(bytes32 => bool))` | public |
| 51 | — | — | `nullifiers` | `mapping(uint256 => mapping(bytes32 => bool))` | public |
| 52 | — | — | `verificationKeys` | `mapping(uint256 => mapping(uint256 => VerifyingKey))` | internal |
| 53 | 0 | 1 | `testingMode` | `bool` | public |
| 54 | — | — | `snarkSafetyVector` | `mapping(uint256 => bool)` | public (**never read or written** — reserved) |
| 55 | 0 | 32 | `lastEventBlock` | `uint256` | public |
| 56 | 0 | 20 | `owner` | `address` | public |
| 56 | 20 | 1 | `initialized` | `bool` | public |
| 57 | 0 | 20 | `hookRouter` | `address` | public |
| 57 | 20 | 4 | `defaultFinalityThreshold` | `uint32` | public |
| 58 | 0 | 20 | `shieldPauseContract` | `address` | public |
| 59 | 0 | 20 | `feeModule` | `address` | public |
| 59 | 0 | 20 | `feeModule` | `address` | public |
| 60 | — | — | `remoteHookRouters` | `mapping(uint32 => bytes32)` | public (added post-drift, D-16) |
| 61 | 0 | 32 | `_reentrancyStatus` | `uint256` (0 = not entered) | internal (added post-drift, D-18) |
| 62 | 0 | 20 | `adapterRegistry` | `address` (timelock-governed privilege source) | public (added post-drift, D-18) |
| 63–105 | — | — | `__gap` | `uint256[43]` | private (reserved) |

Slot 11 (`privilegedShieldCallers`) is **retired but retained** (never removed/reordered): shield-fee exemption is now derived from `adapterRegistry` (slot 62), and the legacy mapping is always the zero default.

Rules for future changes: append new variables immediately before `__gap` and shrink `__gap` accordingly; never reorder, remove, or change the type of an existing variable.

Auto-generated public getters exist for every `public` variable above (plus the `ZERO_VALUE()` constant getter). Their selectors are part of the frozen ABI.

---

## 5. `PrivacyPool` (router)

Solidity `^0.8.17`. Implements the CCTP V2 message-handler interface. All mutability is `nonpayable` unless noted.

### 5.1 Initialization

| | |
|---|---|
| Signature | `initialize(address _shieldModule, address _transactModule, address _merkleModule, address _verifierModule, address _tokenMessenger, address _messageTransmitter, address _usdc, uint32 _localDomain, address _owner, address payable _treasury)` |
| Selector | `0xa928b9ae` |
| Access | Deployer-only (`msg.sender == deployer`, where `deployer` is a private immutable set in the constructor); callable exactly once. **OQ-7 resolved post-drift**: the gate prevents a front-runner from initializing the pool with malicious params on a public chain. |

Behavior, in order:
1. `require(msg.sender == deployer, "PrivacyPool: Only deployer")`.
2. `require(!initialized, "PrivacyPool: Already initialized")`.
2. Zero-address checks, **in this order**, each reverting with the given string:
   `_shieldModule` → `"PrivacyPool: zero shieldModule"`; `_transactModule` → `"PrivacyPool: zero transactModule"`; `_merkleModule` → `"PrivacyPool: zero merkleModule"`; `_verifierModule` → `"PrivacyPool: zero verifierModule"`; `_tokenMessenger` → `"PrivacyPool: zero tokenMessenger"`; `_messageTransmitter` → `"PrivacyPool: zero messageTransmitter"`; `_usdc` → `"PrivacyPool: zero usdc"`; `_owner` → `"PrivacyPool: zero owner"`; `_treasury` → `"PrivacyPool: zero treasury"`.
3. Assign the four module addresses, then `tokenMessenger`, `messageTransmitter`, `usdc`, `localDomain`, `owner`, `treasury`.
4. `delegatecall` `merkleModule.initializeMerkle()` (§6.1).
5. Set `initialized = true`.

No event is emitted. `treasury` has no setter (documented as immutable after init); `owner` has no setter either.

### 5.2 User-facing operations

| Function | Selector | Behavior |
|---|---|---|
| `shield(ShieldRequest[] calldata, address integrator)` | `0xcd6a3d7f` | `delegatecall` → `ShieldModule.shield` (§7.1). Reverts bubble verbatim. |
| `transact(Transaction[] calldata)` | `0xd8ae136a` | `delegatecall` → `TransactModule.transact` (§8.1). |
| `atomicCrossChainUnshield(Transaction calldata, uint32 destinationDomain, address finalRecipient, uint256 maxFee, bytes32 uniqueNonce) returns (uint64)` | `0xe8d1f224` | `delegatecall` → `TransactModule.atomicCrossChainUnshield` (§8.2); ABI-decodes and returns the `uint64`. Selector/signature changed post-drift (D-16): `destinationCaller` removed (pinned on-chain), `uniqueNonce` added. |

### 5.3 CCTP V2 message handlers

**`handleReceiveFinalizedMessage(uint32 remoteDomain, bytes32 sender, uint32 finalityThresholdExecuted, bytes calldata messageBody) returns (bool)`** — selector `0x11cffb67`:

1. `require(msg.sender == hookRouter || msg.sender == tokenMessenger, "PrivacyPool: Unauthorized caller")`.
2. `require(finalityThresholdExecuted >= 2000, "PrivacyPool: Insufficient finality")` (`CCTPFinality.STANDARD`).
3. `remoteDomain` and `sender` are **ignored** (**OQ-3**).
4. Shared processing: decode `messageBody` as a CCTP V2 burn message, extracting `(grossAmount, feeExecuted, hookData)` (reverts `"BurnMessageV2: message too short"` if the body is shorter than the fixed burn-message header). `actualAmount = grossAmount - feeExecuted` (checked subtraction).
5. Decode `hookData` as `CCTPPayload`. If `messageType == SHIELD`: decode `ShieldData[]` (a note ARRAY post-drift, D-15) and `delegatecall` `ShieldModule.processIncomingShield(actualAmount, shieldNotes)` (§7.2). Otherwise revert `"PrivacyPool: Invalid message type"` (the Hub never accepts UNSHIELD payloads).
6. Return `true`.

**`handleReceiveUnfinalizedMessage(...)`** — selector `0x7c92f219`: identical except step 2 requires `finalityThresholdExecuted >= 1000` (`CCTPFinality.FAST`), reverting `"PrivacyPool: Finality below minimum"`.

### 5.4 Admin functions

All revert with `"PrivacyPool: Only owner"` unless `msg.sender == owner`.

| Function | Selector | Extra checks / effects | Event |
|---|---|---|---|
| `setRemotePool(uint32 domain, bytes32 poolAddress)` | `0x37bc0324` | `remotePools[domain] = poolAddress` | `RemotePoolSet(domain, poolAddress)` |
| `setVerificationKey(uint256 n, uint256 m, VerifyingKey calldata key)` | `0x2ec0f359` | `delegatecall` → `VerifierModule.setVerificationKey` (§9.1; owner re-checked inside the module) | `VerifyingKeySet` (from module) |
| `setShieldFee(uint120 feeBps)` | `0x47338389` | `require(feeBps <= 10000, "PrivacyPool: Fee too high")`; sets `shieldFee` | none |
| `setTestingMode(bool enabled)` | `0x596d7a68` | `delegatecall` → `VerifierModule.setTestingMode`, then emits `TestingModeSet` **again** — two identical events per call (**OQ-8**) | `TestingModeSet` ×2 |
| `setHookRouter(address)` | `0xdf4af94b` | sets `hookRouter` | none |
| `setRemoteHookRouter(uint32 domain, bytes32 routerAddress)` | `0x7c1cc0ed` | sets `remoteHookRouters[domain]` (pin for outbound burn `destinationCaller`, D-16) | none |
| `setAdapterRegistry(address)` | `0x5b34b823` | set-once: `require(adapterRegistry == address(0))` + non-zero arg (D-18) | none |
| `addToBlocklist(address[])` | `0xf71a55f8` | sets `tokenBlocklist[t] = true`, skips already-blocked; reverts `"PrivacyPool: cannot block USDC"` on the core asset (blocking it would strand in-flight cross-chain shields) | `AddToBlocklist(token)` per newly blocked token |
| `removeFromBlocklist(address[])` | `0xab63e69c` | clears `tokenBlocklist[t]` | `RemoveFromBlocklist(token)` per newly unblocked token |
| `setDefaultFinalityThreshold(uint32 threshold)` | `0x50fe9314` | `require(threshold == 1000 \|\| threshold == 2000, "PrivacyPool: Invalid threshold")` | `DefaultFinalityThresholdSet(threshold)` |
| `setShieldPauseContract(address)` | `0x6960c7da` | sets `shieldPauseContract` (note: declared on the contract but absent from the router interface) | `ShieldPauseContractSet(addr)` |
| `setFeeModule(address)` | `0x2088df1b` | sets `feeModule` (`address(0)` = flat-fee fallback) | `FeeModuleSet(addr)` |

### 5.5 Views and self-call functions implemented directly on the router

| Function | Selector | Behavior |
|---|---|---|
| `getVerificationKey(uint256 n, uint256 m) returns (VerifyingKey)` | `0x7b12ae83` | Returns `verificationKeys[n][m]` (zero struct if unset). |
| `verify(Transaction calldata) returns (bool)` | `0xee990783` | **This is the live verification path** (see §9.3 and **OQ-2**). |
| `getInsertionTreeNumberAndStartingIndex(uint256) returns (uint256 treeNum, uint256 startIndex)` | `0x0c9c0c8d` | Returns `(treeNumber, nextLeafIndex)`. **Ignores its argument** — no rollover awareness (**OQ-1**). |
| `insertLeaves(bytes32[])` | `0xdc52bf9f` | `require(msg.sender == address(this), "Only self")`, then `delegatecall` → `MerkleModule.insertLeaves` (§6.2). |

Plus all auto-generated storage getters listed in §4.

### 5.6 `verify` semantics (router — normative)

1. If `testingMode` is `true`, return `true` immediately.
2. `N = nullifiers.length`, `M = commitments.length`. Load `verificationKeys[N][M]`.
3. `require(key.alpha1.x != 0, "PrivacyPool: Verification key not set")`.
4. Build the public-input vector per §2.3.
5. `validity = Snark.verify(key, proof, inputs)` (Groth16 pairing check, §10.5).
6. If `tx.origin == VERIFICATION_BYPASS`, return `true` — **after** steps 2–5 have already run (so estimation still pays verification cost and reverts for unregistered shapes; **OQ-4**).
7. Return `validity`.

### 5.7 `_delegatecall` helper (all router forwards)

1. `require(module != address(0), "PrivacyPool: Module not set")`.
2. `(success, result) = module.delegatecall(data)`.
3. On failure: if `result.length > 0`, revert bubbled verbatim via assembly (`revert(add(result, 32), mload(result))`); else revert `"PrivacyPool: Delegatecall failed"`.

---

## 6. `MerkleModule`

Incremental binary Poseidon Merkle tree, depth 16, batch insertion. All externals are `onlyDelegatecall`.

### 6.1 `initializeMerkle()` — selector `0x2d974a4c`

Called exactly once from `PrivacyPool.initialize`:
- `zeros[0] = ZERO_VALUE`; then for `i` in `[0, 16)`: store `zeros[i] = currentZero`, `filledSubTrees[i] = currentZero`, and `currentZero = hashLeftRight(currentZero, currentZero)`.
  (Net effect: `zeros[i]` is the zero node at level `i`; `zeros[0]` is written twice — harmless.)
- `newTreeRoot = merkleRoot = currentZero` (the root of the fully empty depth-16 tree).
- `rootHistory[0][merkleRoot] = true`. (`treeNumber` is 0; `nextLeafIndex` remains 0.)

### 6.2 `insertLeaves(bytes32[] memory leafHashes)` — selector `0xdc52bf9f`

1. `count = leafHashes.length`; if `count == 0`, return (no-op; no root-history write).
2. **Rollover:** if `nextLeafIndex + count > 2**16` (strictly greater — an exactly-full tree does *not* roll over), start a new tree: `merkleRoot = newTreeRoot`; `nextLeafIndex = 0`; `treeNumber += 1`. (`filledSubTrees` is **not** reset — its stale values are provably never read for the new tree.) All `count` leaves always land in a single tree.
3. **Batch insertion** (in-place; the input memory array is deliberately mutated and MUST NOT be reused by the caller):
   - `levelInsertionIndex = nextLeafIndex`; then `nextLeafIndex += count`.
   - For each `level` in `[0, 16)`: fold the remaining elements pairwise into the front of the array. If `levelInsertionIndex` is odd, first hash the pending element with `filledSubTrees[level]` (left sibling) and advance by one. Then process pairs: the right element is the next pending leaf, or `zeros[level]` if none remains. Whenever the last or second-to-last pending element is consumed, update `filledSubTrees[level]` to that element. Carry `count = nextLevelHashIndex + 1` and `levelInsertionIndex >>= 1` to the next level.
   - After level 15, `leafHashes[0]` holds the new root.
4. `merkleRoot = leafHashes[0]`; `rootHistory[treeNumber][merkleRoot] = true`.

The rewrite MUST reproduce this tree byte-for-byte: identical roots for identical insertion sequences, verified against existing test vectors/differential tests.

### 6.3 `hashLeftRight(bytes32, bytes32) returns (bytes32)` — selector `0x38bf282e`

`pure`. Returns `PoseidonT3.poseidon([left, right])`.

### 6.4 `getInsertionTreeNumberAndStartingIndex(uint256 newCommitments)` — selector `0x0c9c0c8d`

`view`. If `nextLeafIndex + newCommitments > 2**16`, returns `(treeNumber + 1, 0)`; else `(treeNumber, nextLeafIndex)`. **Note:** this rollover-aware implementation lives in the module and is only reachable via `delegatecall`, which the router never performs for this function — the router's own argument-ignoring view (§5.5) is what actually serves callers. See **OQ-1**.

---

## 7. `ShieldModule`

Module-private constant `BASIS_POINTS = 10000`. All externals are `onlyDelegatecall`.

### 7.1 `shield(ShieldRequest[] calldata requests, address integrator)` — selector `0xcd6a3d7f`

1. **Pause check:** if `shieldPauseContract != address(0)`, `require(!IShieldPauseController(shieldPauseContract).shieldsPaused(), "ShieldModule: shields paused")`.
2. `require(requests.length > 0, "ShieldModule: No requests")`.
3. For each request `i`, in order:
   a. **Validate preimage** (checks in this order):
      - `value > 0` else `"ShieldModule: Invalid value"`;
      - `!tokenBlocklist[token.tokenAddress]` else `"ShieldModule: Token blocked"`;
      - `uint256(npk) < SNARK_SCALAR_FIELD` else `"ShieldModule: Invalid npk"`;
      - if `tokenType == ERC721`: `value == 1` else `"ShieldModule: Invalid NFT value"` (unreachable in practice — **OQ-6**).
   b. **Pull tokens & apply fee** (`_transferTokenIn`, §7.3) → `(adjustedPreimage, fee)`.
   c. `leaf[i] = commitmentHash(adjustedPreimage)`; collect ciphertext.
   (A failure on request `i` reverts the entire batch — the operation is atomic.)
4. Read `(treeNum, startIndex)` from the router's `getInsertionTreeNumberAndStartingIndex(requests.length)` (**pre-insertion** values — **OQ-1**).
5. `emit Shield(treeNum, startIndex, adjustedPreimages[], ciphertext[], fees[])` — **before** tree insertion.
6. Self-call `insertLeaves(leaves)` (§6.2).
7. `lastEventBlock = block.number`.

### 7.2 `processIncomingShield(uint256 amount, ShieldData[] calldata datas)` — selector `0xffd149d4`

Invoked by the router's CCTP handler after USDC has already been minted to the pool. Post-drift (D-15) the payload is a note ARRAY: index 0 is the recipient note (it absorbs the CCTP protocol fee); any further notes (e.g. a relayer fee note) mint at their full declared value.

1. Same pause check as §7.1 step 1.
2. `require(datas.length > 0, "ShieldModule: no shield notes")`.
3. `feeSum = Σ datas[i].value` for `i ≥ 1`; `require(amount > feeSum, "ShieldModule: fee notes exceed received amount")`.
4. Sanity: `require(amount <= Σ datas[i].value (all i), "ShieldModule: Amount exceeds declared value")` — the delivered net amount must fit within the total declared gross burn.
5. For each note `i`: `noteValue = i == 0 ? amount - feeSum : datas[i].value`; build the USDC `ShieldRequest` from `datas[i]`; validate (§7.1(a)); fee-adjust via §7.4 (`integrator = datas[i].integrator`). **Note:** tokens are already in the contract, so fees (if any) are paid **out of the pool's own USDC balance**; the fee-exemption check inspects `msg.sender`, which here is the `hookRouter`/`tokenMessenger` (normally not a registered adapter).
6. Read the router insertion position for all `n` leaves; `emit Shield(...)` **once** with all commitments/ciphertexts/fees (same shape as local `shield`); `insertLeaves` in one batch; `lastEventBlock = block.number`.

### 7.3 `_transferTokenIn(preimage, integrator)` (local-shield token pull)

`require(tokenType == ERC20, "ShieldModule: Only ERC20 supported")` — first check. Then one of three branches:

| Branch | Condition | Token movements (all from `msg.sender` unless noted) | Commitment value |
|---|---|---|---|
| Privileged | `_isPrivilegedShieldCaller(msg.sender)` — post-drift (D-18): derived from the timelock-governed `adapterRegistry` (`authorizedAdapters(c) || withdrawOnlyAdapters(c)`); when the registry is unset, no caller is privileged. The owner-set `privilegedShieldCallers` map is retired (inert slot). | pull full `value` to pool; `fee = 0` | `value` |
| Fee module | `feeModule != address(0)` | `(armadaTake, integratorFee, totalFee) = feeModule.calculateShieldFee(integrator, value)`; pull `base = value - totalFee` to pool; pull `armadaTake` → `treasury` (if `> 0` and `treasury != 0`); pull `integratorFee` → `integrator` (if `> 0` and `integrator != 0`); then `feeModule.recordShieldFee(token, integrator, value, armadaTake, integratorFee)` | `base` |
| Flat fee | otherwise | `(base, fee) = _getFee(value, inclusive=true, shieldFee)`; pull `base` to pool; pull `fee` → `treasury` (if `> 0` and `treasury != 0`) | `base` |

Every pull of the pool's own balance is balance-delta checked: `balanceAfter - balanceBefore == expected`, else revert `"ShieldModule: Transfer failed"` (rejects fee-on-transfer/rebasing tokens). Fee pulls to treasury/integrator are **not** delta-checked. All ERC20 movements use SafeERC20. `base` is narrowed to `uint120` via explicit cast (the upstream subtraction is checked arithmetic).

### 7.4 `_applyShieldFee(preimage, integrator)` (cross-chain path)

Same fee selection as §7.3 but for notes whose tokens are ALREADY in the contract: if privileged → no fee; else if `feeModule != 0` → `calculateShieldFee`, set `value = amount - totalFee`, **safeTransfer** `armadaTake` → treasury and `integratorFee` → integrator from the pool's balance, then `recordShieldFee`; else if `shieldFee > 0` → flat inclusive fee, safeTransfer fee → treasury. Returns the fee-adjusted preimage + fee; hashing/insertion/event emission are batched by the caller (§7.2 step 6).

### 7.5 Helpers

- `_getFee(uint136 amount, bool isInclusive, uint120 feeBP)`: if `feeBP == 0` return `(amount, 0)`; inclusive → §2.4 flat formula; exclusive → dead code (**OQ-5**).
- `_hashCommitment` / `_getTokenID`: §2.2 formulas.
- `_requireShieldsNotPaused`: §7.1 step 1.

---

## 8. `TransactModule`

All externals are `onlyDelegatecall`.

### 8.1 `transact(Transaction[] calldata txs)` — selector `0xd8ae136a`

1. `require(txs.length > 0, "TransactModule: No transactions")`.
2. **Emergency pause:** if `shieldPauseContract != 0`, `require(!emergencyPaused(), "TransactModule: emergency paused")`.
3. **Withdraw-only mode:** if `shieldPauseContract != 0` and `withdrawOnlyMode()` is true, every transaction must have `boundParams.unshield != NONE`, else revert `"TransactModule: withdraw only"`.
4. `commitmentsCount = Σ txs[i].boundParams.commitmentCiphertext.length` (note: ciphertext count, **not** `commitments.length` — for unshield transactions the unshield output is excluded).
5. **First pass**, per transaction in order:
   a. `_validateTransaction` (§8.3); on failure revert `"TransactModule: " ++ reason`.
   b. `_accumulateAndNullify` (§8.4): marks nullifiers, emits `Nullified`, copies the first `commitmentCiphertext.length` entries of `commitments[]`/`commitmentCiphertext[]` into batch accumulators.
6. **Second pass**, per transaction: if `unshield != NONE`, `_transferTokenOut(unshieldPreimage)` (§8.5). (Deliberately after *all* nullifiers are marked.)
7. If `commitmentsCount > 0`: read position from router (**OQ-1**), `emit Transact(treeNum, startIndex, commitmentHashes[], ciphertext[])`, self-call `insertLeaves(commitmentHashes)`.
8. `lastEventBlock = block.number`.

### 8.2 `atomicCrossChainUnshield(Transaction calldata tx, uint32 destinationDomain, address finalRecipient, uint256 maxFee, bytes32 uniqueNonce) returns (uint64 nonce)` — selector `0xe8d1f224`

Post-drift (D-16): `destinationCaller` is no longer caller-supplied (pinned on-chain to `remoteHookRouters[destinationDomain]`); `uniqueNonce` is an opaque per-tx marker echoed into the hookData for off-chain delivery matching (not fund-relevant).

1. Emergency-pause check (as §8.1 step 2). (No withdraw-only check — unshields are always allowed outside the emergency window.)
2. Input validation, in order:
   - `destinationDomain != localDomain` else `"TransactModule: Use local unshield"`;
   - `finalRecipient != address(0)` else `"TransactModule: Invalid recipient"`;
   - `tx.boundParams.unshield != NONE` else `"TransactModule: Must include unshield"`;
   - `remotePools[destinationDomain] != bytes32(0)` else `"TransactModule: Unknown destination"`;
   - `remoteHookRouters[destinationDomain] != bytes32(0)` else `"TransactModule: Hook router not configured"`;
   - `tx.boundParams.adaptContract == address(0)` else `"TransactModule: unexpected adaptContract"`;
   - **Destination binding:** `CCTPBindingLib.verify(tx.boundParams.adaptParams, finalRecipient, destinationDomain, maxFee)` else `"TransactModule: destination not bound to proof"`. `adaptParams` must equal `keccak256(abi.encode(DOMAIN_TAG, recipient, domain, maxFee))` with `DOMAIN_TAG = keccak256("ArmadaCCTPUnshield.v1")` — since `adaptParams` is a SNARK public input (via `hashBoundParams`), this binds the plaintext destination tuple to the proof with no circuit change, and blocks hijacking a local unshield (adaptParams == 0) through this path;
   - `_validateTransaction(tx)` (§8.3), reverting `"TransactModule: " ++ reason`.
   - **Note:** `unshieldPreimage.token` is **not** checked against `usdc` — the burn always burns `usdc` (**OQ-9**).
3. Process: if `boundParams.commitmentCiphertext.length > 0` — `_accumulateAndNullify` into fresh accumulators, read router position, `emit Transact(...)`, `insertLeaves`. Otherwise `_accumulateAndNullify` with empty arrays (nullifiers still marked; `Nullified` still emitted; no `Transact` event, no tree insertion).
4. Burn & bridge:
   - `base = unshieldPreimage.value`; `fee = 0` (unshields are free, D-2).
   - `require(maxFee <= base, "TransactModule: maxFee exceeds base")`.
   - `hookData = abi.encode(CCTPPayload(UNSHIELD, abi.encode(UnshieldData(finalRecipient, uniqueNonce))))`.
   - `IERC20(usdc).safeApprove(tokenMessenger, 0)` then `safeApprove(tokenMessenger, base)` — the zero-reset is required because OZ 4.9 `safeApprove` reverts on a non-zero→non-zero change, and a residual TokenMessenger allowance would otherwise brick later burns.
   - `finality = defaultFinalityThreshold > 0 ? defaultFinalityThreshold : 2000` (inlined).
   - `ITokenMessengerV2(tokenMessenger).depositForBurnWithHook(base, destinationDomain, remotePools[destinationDomain], usdc, remoteHookRouters[destinationDomain], maxFee, finality, hookData)`.
   - `nonce = 0` — always; this CCTP V2 call returns no nonce.
5. `emit CrossChainUnshieldInitiated(destinationDomain, finalRecipient, base, 0)`; `emit Unshield(finalRecipient, unshieldPreimage.token, base, 0)`; `lastEventBlock = block.number`.

### 8.3 `_validateTransaction(tx)` — checks in exact order

| # | Check | Failure reason string (wrapped as `"TransactModule: <reason>"`) |
|---|---|---|
| 1 | `tx.gasprice >= boundParams.minGasPrice` | `"Gas price too low"` |
| 2 | `boundParams.adaptContract == address(0) \|\| boundParams.adaptContract == msg.sender` | `"Invalid Adapt Contract"` |
| 3 | `boundParams.chainID == block.chainid` | `"ChainID mismatch"` |
| 4 | `rootHistory[boundParams.treeNumber][tx.merkleRoot] == true` | `"Invalid Merkle Root"` |
| 5 | If `unshield != NONE`: `commitmentCiphertext.length == commitments.length - 1` | `"Invalid Ciphertext Length"` |
| 6 | If `unshield != NONE`: unshield-output hash check (below) | `"Invalid Unshield Note"` |
| 7 | If `unshield == NONE`: `commitmentCiphertext.length == commitments.length` | `"Invalid Ciphertext Length"` |
| 8 | Router `verify(tx) == true` | `"Invalid Proof"` |

Step 6 detail: for `REDIRECT`, hash a copy of `unshieldPreimage` with `npk` **replaced by** `bytes32(uint256(uint160(msg.sender)))`; otherwise hash `unshieldPreimage` as-is. The hash must equal `commitments[commitments.length - 1]`. (Consequence: an unshield transaction must have at least one commitment, since `commitments.length - 1` would underflow; for `REDIRECT` the payout still goes to the address encoded in the preimage's `npk`, §8.5 — the `msg.sender` binding is only a hash-check constraint.)

### 8.4 `_accumulateAndNullify(tx, accumulators, offset)`

For each nullifier `n`: `require(!nullifiers[boundParams.treeNumber][n], "TransactModule: Note already spent")`, then set it `true`. Then `emit Nullified(boundParams.treeNumber, tx.nullifiers)` — emitted even when the nullifier array is empty. Then copy `commitments[0..ciphertextLength)` and `commitmentCiphertext[0..ciphertextLength)` into the accumulators starting at `offset`.

### 8.5 `_transferTokenOut(preimage)` (local unshield)

`require(tokenType == ERC20, "TransactModule: Only ERC20 supported")`. `recipient = address(uint160(uint256(preimage.npk)))`. Post-drift (D-18): `require(recipient != address(this), "TransactModule: unshield to pool")` — a cross-chain unshield proof pays out to the pool; replaying it through plain `transact()` would otherwise send USDC pool→pool, burn the note, and strand the funds (cross-path replay). `token.safeTransfer(recipient, preimage.value)`. `emit Unshield(recipient, preimage.token, preimage.value, 0)` (fee hard-coded to 0, D-2).

---

## 9. `VerifierModule`

### 9.1 Functions

| Function | Selector | Guard | Behavior |
|---|---|---|---|
| `setVerificationKey(uint256 n, uint256 m, VerifyingKey calldata key)` | `0x2ec0f359` | `onlyDelegatecall` + `require(msg.sender == owner, "VerifierModule: Only owner")` | `verificationKeys[n][m] = key`; `emit VerifyingKeySet(n, m, key)`. Overwrites silently; no deletion; no structural validation of the key. |
| `getVerificationKey(uint256 n, uint256 m) returns (VerifyingKey)` | `0x7b12ae83` | none (view) | Returns mapping entry. Unreachable via router (router has its own); harmless. |
| `verify(Transaction calldata) returns (bool)` | `0xee990783` | `onlyDelegatecall` view | **Reverts** `"VerifierModule: verify handled by PrivacyPool router"`. Post-drift (D-17): verification is centralized on the router (§5.6); the module-level copy was removed to kill silent-drift risk between two implementations. **OQ-2 RESOLVED.** |
| `hashBoundParams(BoundParams calldata) returns (uint256)` | `0x28f89c3a` | none (pure) | `uint256(keccak256(abi.encode(bp))) % SNARK_SCALAR_FIELD`. |
| `setTestingMode(bool)` | `0x596d7a68` | `onlyDelegatecall` + owner (`"VerifierModule: Only owner"`) | Sets `testingMode`; `emit TestingModeSet(enabled)`. |

### 9.2 VK registry semantics

- Keys are indexed by circuit shape `(nullifierCount, commitmentCount)` taken from the transaction's array lengths.
- A key is considered "set" iff `alpha1.x != 0`.
- Any unregistered shape reverts at verification time.
- `VerifyingKey.artifactsIPFSHash` is informational; `ic` length must equal `3 + N + M` (public inputs `2 + N + M`, plus one) for the Groth16 check to be well-formed.

### 9.3 Live verification path

`TransactModule` calls `IVerifierModule(address(this)).verify(tx)` — a **staticcall to the router**, whose own `verify` (§5.6) executes. Post-drift (D-17) the router copy is the ONLY implementation; the module's `verify` reverts. **OQ-2 resolved.**

---

## 10. External Dependencies (behavioral contracts)

| Dependency | Interface consumed | Behavioral assumptions |
|---|---|---|
| CCTP `ITokenMessengerV2` | `depositForBurnWithHook(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold, bytes hookData)` | Burns `amount` of `burnToken` (approval pulled); emits a V2 message. No return value used. |
| CCTP `IMessageTransmitterV2` | `receiveMessage(bytes message, bytes attestation) returns (bool)`, `localDomain()` | Drives the hook handlers on this contract (via hook router). |
| Burn message V2 decoding | fixed-offset decoding of `amount` (offset in the burn-message body), `feeExecuted`, `hookData`; reverts `"BurnMessageV2: message too short"` below minimum length | Layout must match Circle's MessageTransmitterV2 byte-for-byte. |
| `IArmadaFeeModule` (`feeModule`) | `calculateShieldFee(address integrator, uint256 amount) returns (uint256 armadaTake, uint256 integratorFee, uint256 totalFee)` (view); `recordShieldFee(address asset, address integrator, uint256 amount, uint256 armadaTakePaid, uint256 integratorFeePaid)` | `totalFee == armadaTake + integratorFee ≤ amount` (upstream subtraction is checked); `recordShieldFee` accepts the pool as an authorized caller. See `specs/FEE_STRUCTURE.md`. |
| `IShieldPauseController` (`shieldPauseContract`) | `shieldsPaused()`, `withdrawOnlyMode()`, `emergencyPaused()` (all view) | `address(0)` disables all three checks. |
| Poseidon libraries | `PoseidonT3.poseidon(bytes32[2])`, `PoseidonT4.poseidon(bytes32[3])` (pure) | Bytecode-generated circomlib-compatible Poseidon over BN254; must reproduce identical digests. |
| `Snark` library | `verify(VerifyingKey, SnarkProof, uint256[] inputs) returns (bool)` | Groth16 over BN254 via `ecAdd`/`ecMul`/`ecPairing` precompiles; reverts `"Snark: Input > SNARK_SCALAR_FIELD"` if any input ≥ field; `ic` length must equal `inputs.length + 1`; returns the pairing-check boolean. |
| `IERC20` + SafeERC20 | `transferFrom`, `transfer`, `approve`, `balanceOf` | USDC (6-decimals, no fee-on-transfer) is the only token exercised end-to-end; arbitrary ERC20 shields are accepted by the code paths. |

---

## 11. Events Catalog (topic0 frozen — SDK log scanning depends on these)

| Event | topic0 | Emitted by (path) |
|---|---|---|
| `Shield(uint256 treeNumber, uint256 startPosition, CommitmentPreimage[] commitments, ShieldCiphertext[] shieldCiphertext, uint256[] fees)` | `0x3a5b9dc26075a3801a6ddccf95fec485bb7500a91b44cec1add984c21ee6db3b` | §7.1, §7.4 — before tree insertion |
| `Transact(uint256 treeNumber, uint256 startPosition, bytes32[] hash, CommitmentCiphertext[] ciphertext)` | `0x56a618cda1e34057b7f849a5792f6c8587a2dbe11c83d0254e72cb3daffda7d1` | §8.1, §8.2 — only when new commitments exist |
| `Unshield(address to, TokenData token, uint256 amount, uint256 fee)` | `0xd93cf895c7d5b2cd7dc7a098b678b3089f37d91f48d9b83a0800a91cbdf05284` | §8.5 (local) and §8.2 (cross-chain; `fee` always 0) |
| `Nullified(uint16 treeNumber, bytes32[] nullifier)` | `0x781745c57906dc2f175fec80a9c691744c91c48a34a83672c41c2604774eb11f` | §8.4 — even for empty nullifier arrays |
| `CrossChainUnshieldInitiated(uint32 indexed destinationDomain, address indexed recipient, uint256 amount, uint64 nonce)` | `0x9a8234aef148991bd0f1e08df206eb275078881051bd92a2d81a1afd0ff37f4a` | §8.2 (`nonce` always 0) |
| `RemotePoolSet(uint32 indexed domain, bytes32 poolAddress)` | `0x019190ca21b03575fe0ef686ebc94279721ca06510c186ee3a8d26cfa5d70023` | §5.4 |
| `TestingModeSet(bool enabled)` | `0x21f67800fb06e35b87566708fd49f2a7cc96bf3a74ca56e175b23e6f35b10248` | §5.4 (emitted twice per call — **OQ-8**) |
| `DefaultFinalityThresholdSet(uint32 threshold)` | `0xe58be3486b5925aab80f886258894ea495baffc3fdd4f7432efd0cb26a3f1314` | §5.4 |
| `ShieldPauseContractSet(address indexed)` | `0xd944792a6be77df7bcf2b336a0c0af6fb2e715460c8f79e90264f4966fbc74c6` | §5.4 |
| `FeeModuleSet(address indexed)` | `0xfd559fabeec56b489dcf6cf0c7a8c863ed2dd88016bf8d905c72dbdfdc685d29` | §5.4 |
| `VerifyingKeySet(uint256 nullifiers, uint256 commitments, VerifyingKey key)` | `0x3d09e10d1c966d01c4a2c14d0ac9af253486aa5e99b6cffe9019c4d43eb1fb23` | §9.1 |
| `AddToBlocklist(address indexed token)` | `0x46742f555939247f80b50a8ca895a561933c48bc9a06ccb0c812e97ac723d33f` | §5.4 (post-drift, D-18) |
| `RemoveFromBlocklist(address indexed token)` | `0x2ef13bd1aff17b0f9c85afaf228e84266c8394d9d381735e83fe23f607113e2e` | §5.4 (post-drift, D-18) |

`lastEventBlock = block.number` is written on every successful `shield`, `processIncomingShield`, `transact`, and `atomicCrossChainUnshield` (wallet-sync support).

---

## 12. System Invariants (for the differential test harness)

- **I-1 (Append-only tree):** leaves are never modified or deleted; each `insertLeaves` appends `count` consecutive leaves starting at the pre-call `nextLeafIndex` of a single tree.
- **I-2 (Root-history monotonicity):** `rootHistory` entries are only ever set to `true`; every post-insertion root of the current tree, and the empty root of every tree, is recorded. Historical roots remain valid for proofs forever.
- **I-3 (Rollover):** `treeNumber` increases by exactly 1, only inside `insertLeaves` when `nextLeafIndex + count > 65536`; the new tree starts at leaf index 0 with the cached empty root. A batch never straddles two trees.
- **I-4 (Nullifier uniqueness):** `nullifiers[treeNumber][n]` transitions `false → true` at most once; reuse reverts (`"TransactModule: Note already spent"`). Nullifiers are scoped to `boundParams.treeNumber` (uint16, widened to uint256 for the mapping key).
- **I-5 (Shield conservation):** for each local shield, tokens pulled from the user equal `base + feePaid`; the inserted commitment's value equals `base`. For cross-chain shields, `commitmentValue + feesPaid == amountReceived`. Proven for the flat-fee path in `armada-lean/ArmadaLean/Fee.lean` (`fee_conservation`).
- **I-6 (Transact conservation):** value conservation across inputs/outputs is enforced by the SNARK; the contract contributes: local unshield pays exactly `unshieldPreimage.value`; cross-chain unshield burns exactly `unshieldPreimage.value` of USDC.
- **I-7 (Bounded values):** note values are `uint120`; `npk < SNARK_SCALAR_FIELD` on shield.
- **I-8 (Atomicity):** any failed check reverts the entire user call, including all token movements, nullifier marks, tree inserts, and events of that call.
- **I-9 (Module confinement):** module code never executes against module storage (`onlyDelegatecall`); tree mutation is reachable only via the router's self-call gate (`"Only self"`).
- **I-10 (Fee bounds):** flat `shieldFee ≤ 10000` bps; at 50 bps, shields below 200 base units pay zero fee (floor division — Lean `fee_zero_below_threshold`).
- **I-11 (Event liveness):** `lastEventBlock` equals the block of the most recent successful user operation.

---

## 13. Open Questions (require a team decision before/at rewrite)

| ID | Question | Current behavior |
|---|---|---|
| **OQ-1** | `Shield`/`Transact` events report the **pre-insertion** `(treeNumber, startIndex)` from the router's argument-ignoring view. If a batch triggers tree rollover, the events name the old tree/index while leaves land in `treeNumber + 1` at index 0. Keep (frozen ABI behavior) or fix (accurate events)? Rollover requires >65,536 leaves. | Events may mislabel tree/index at rollover. |
| **OQ-2** | ~~Verification logic exists twice: live copy on the router and a dead copy in VerifierModule.~~ **RESOLVED post-drift (D-17):** verification centralized on the router; the module's `verify` reverts. | Router copy is the only path. |
| **OQ-3** | The CCTP handlers ignore the `sender` field and the source domain — any message that mints USDC to the pool with a SHIELD payload is accepted. Trust model relies on the hook router / TokenMessenger authentication only. Is that the intended security boundary? | `sender`/`remoteDomain` unauthenticated. |
| **OQ-4** | `tx.origin == VERIFICATION_BYPASS` returns `true` only *after* full verification and the VK-set check — it neither saves gas nor tolerates unset keys, and `tx.origin` semantics are deprecated-adjacent. Keep, move earlier, or drop? | Bypass checked last. |
| **OQ-5** | `_getFee`'s exclusive (non-inclusive) branch is unreachable (unshield fee is gone). Drop it, or keep for parity? | Dead code present. |
| **OQ-6** | ERC721/ERC1155 validation branches, `tokenIDMapping`, and `nftFee` are unreachable (both token in/out paths require ERC20). Keep types for ABI/event compatibility but drop the dead checks? | Dead NFT paths present. |
| **OQ-7** | ~~`initialize` is permissionless first-call; if not invoked atomically at deployment it is front-runnable.~~ **RESOLVED post-drift (D-18):** `initialize` is gated to the deployer (private immutable captured in the constructor). | Deployer-only. |
| **OQ-8** | `setTestingMode` emits `TestingModeSet` twice (once inside the module delegatecall, once on the router). Intentional or bug? | Double emission. |
| **OQ-9** | `atomicCrossChainUnshield` does not require `unshieldPreimage.token == USDC` — a proof over a non-USDC note would still burn USDC. Add the check? | Token unchecked. |
| **OQ-10** | `setShieldFee` allows up to 10000 bps (100%). Intended cap? | Cap is 100%. |
| **OQ-11** | `testingMode` exists as a full proof bypass. Production expectation is removal (see deviation register D-3). Confirm removal plan and any staging-net needs. | Owner-toggleable bypass. |
| **OQ-12** | `snarkSafetyVector` storage (slot 54) is never read or written. Retain as reserved (slot must stay either way) but drop the getter? | Dead public mapping. |

---

## Appendix

Intentional deviations from the legacy implementation, and the provenance register for consensus-critical constants (including the `ZERO_VALUE` derivation string), live in **`specs/CONTRACT_REWRITE_DEVIATIONS.md`** — the only document in this repository section where legacy naming may appear.
