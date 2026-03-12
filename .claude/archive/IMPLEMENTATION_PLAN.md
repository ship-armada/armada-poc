# Implementation Plan: Option C - Router + Modules with Native CCTP

## Overview

This plan implements a modular privacy pool architecture using the **hub/client model**:

- **Hub Chain**: Full privacy pool with merkle tree, proof verification, all shielded state
- **Client Chains**: Thin bridge contracts that route USDC to/from the hub

Key features:
1. Hub presents a single contract address to users (the Router)
2. Hub uses delegatecall to modules for bytecode size management
3. Native CCTP V2 integration (IMessageHandlerV2)
4. Atomic cross-chain unshields (proof validated on hub, tokens delivered to client)
5. Mock CCTP that closely simulates real CCTP for eventual testnet deployment

---

## Architecture Diagram

```
CLIENT CHAINS (Thin Bridge)                    HUB CHAIN (Full Privacy Pool)
════════════════════════════                   ═══════════════════════════════

┌─────────────────────────────┐                ┌─────────────────────────────────────────────┐
│     PrivacyPoolClient       │                │            PrivacyPool (Router)             │
│     ~~~~~~~~~~~~~~~~~~      │                │            ~~~~~~~~~~~~~~~~~~~~             │
│                             │                │                                             │
│  No shielded state          │                │  All shielded state:                        │
│  No merkle tree             │                │    - Merkle tree (commitments)              │
│  No proof verification      │                │    - Nullifiers                             │
│                             │                │    - Root history                           │
│  Just bridges USDC:         │                │    - Verification keys                      │
│                             │                │                                             │
│  crossChainShield()         │───CCTP────────▶│  handleReceiveFinalizedMessage()           │
│    → burns USDC             │   SHIELD       │    → routes to ShieldModule                 │
│    → sends shield payload   │                │    → creates commitment in tree             │
│                             │                │                                             │
│  handleReceiveFinalizedMsg()│◀───CCTP───────│  atomicCrossChainUnshield()                 │
│    → receives USDC mint     │   UNSHIELD     │    → validates proof                        │
│    → forwards to recipient  │                │    → nullifies inputs                       │
│                             │                │    → burns USDC via CCTP                    │
│                             │                │                                             │
│  ~150 lines, ~4 KB          │                │  Entry Points (delegate to modules):        │
└─────────────────────────────┘                │    shield()        → ShieldModule           │
                                               │    transact()      → TransactModule         │
                                               │    unshield()      → TransactModule         │
                                               │                                             │
                                               └───────────┬───────────┬───────────┬─────────┘
                                                           │           │           │
                                               ┌───────────▼───┐ ┌─────▼─────┐ ┌───▼───────────┐
                                               │ ShieldModule  │ │ Transact  │ │ MerkleModule  │
                                               │               │ │ Module    │ │               │
                                               │ ~200 lines    │ │ ~350 lines│ │ ~200 lines    │
                                               │ ~6 KB         │ │ ~10 KB    │ │ ~6 KB         │
                                               └───────────────┘ └───────────┘ └───────────────┘
                                                                       │
                                                               ┌───────▼───────┐
                                                               │VerifierModule │
                                                               │               │
                                                               │ ~150 lines    │
                                                               │ ~5 KB         │
                                                               └───────────────┘

Hub total: ~35 KB across 5 contracts (each well under 24 KB limit)
Client: ~4 KB single contract
```

---

## Data Flows

### Flow 1: Cross-Chain Shield (Client → Hub)

```
USER (on Client Chain)
    │
    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 1. User calls PrivacyPoolClient.crossChainShield(amount, npk, bundle, key)  │
│    - Transfers USDC from user to contract                                   │
│    - Encodes CCTPPayload { messageType: SHIELD, data: ShieldData }          │
│    - Calls TokenMessenger.depositForBurnWithHook()                          │
└─────────────────────────────────────────────────────────────────────────────┘
    │
    │ CCTP burns USDC, emits MessageSent
    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 2. Relayer observes MessageSent, fetches attestation (or simulates)         │
│    - Calls MessageTransmitter.receiveMessage() on Hub                       │
└─────────────────────────────────────────────────────────────────────────────┘
    │
    │ CCTP mints USDC to PrivacyPool, calls handleReceiveFinalizedMessage
    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 3. Hub PrivacyPool.handleReceiveFinalizedMessage()                          │
│    - Decodes CCTPPayload, sees messageType == SHIELD                        │
│    - Delegatecalls ShieldModule.processIncomingShield()                     │
│    - ShieldModule creates commitment, inserts into merkle tree              │
│    - Emits Shield event                                                     │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Flow 2: Local Operations on Hub

```
USER (on Hub Chain)
    │
    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ Local Shield: PrivacyPool.shield(ShieldRequest[])                           │
│    - Transfers USDC from user                                               │
│    - Creates commitment, inserts into merkle tree                           │
└─────────────────────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ Private Transfer: PrivacyPool.transact(Transaction[])                       │
│    - Validates ZK proof                                                     │
│    - Nullifies spent notes                                                  │
│    - Inserts new commitments                                                │
└─────────────────────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ Local Unshield: PrivacyPool.transact(Transaction[] with UnshieldType.NORMAL)│
│    - Validates ZK proof                                                     │
│    - Nullifies spent notes                                                  │
│    - Transfers USDC to recipient address (encoded in npk)                   │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Flow 3: Atomic Cross-Chain Unshield (Hub → Client)

```
USER (on Hub Chain)
    │
    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 1. User calls PrivacyPool.atomicCrossChainUnshield(                         │
│        transaction,      // ZK proof for unshield                           │
│        destinationDomain, // Client chain CCTP domain                       │
│        finalRecipient    // Address to receive USDC on client               │
│    )                                                                        │
│                                                                             │
│    Hub validates proof, nullifies inputs, then:                             │
│    - Encodes CCTPPayload { messageType: UNSHIELD, data: { recipient } }     │
│    - Calls TokenMessenger.depositForBurnWithHook()                          │
└─────────────────────────────────────────────────────────────────────────────┘
    │
    │ CCTP burns USDC on Hub, emits MessageSent
    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 2. Relayer observes MessageSent, fetches attestation (or simulates)         │
│    - Calls MessageTransmitter.receiveMessage() on Client                    │
└─────────────────────────────────────────────────────────────────────────────┘
    │
    │ CCTP mints USDC to PrivacyPoolClient, calls handleReceiveFinalizedMessage
    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 3. Client PrivacyPoolClient.handleReceiveFinalizedMessage()                 │
│    - Decodes CCTPPayload, sees messageType == UNSHIELD                      │
│    - Transfers USDC to finalRecipient                                       │
│    - NO proof validation needed (Hub already validated)                     │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Message Types & Payloads

```solidity
enum MessageType {
    SHIELD,     // Client → Hub: shield request with commitment data
    UNSHIELD    // Hub → Client: unshield with recipient address
}

struct CCTPPayload {
    MessageType messageType;
    bytes data;  // Type-specific encoded data
}

// MessageType.SHIELD data (Client → Hub):
struct ShieldData {
    bytes32 npk;
    uint120 value;
    bytes32[3] encryptedBundle;
    bytes32 shieldKey;
}

// MessageType.UNSHIELD data (Hub → Client):
struct UnshieldData {
    address recipient;  // Final recipient on client chain
}
```

Note: The UNSHIELD payload is minimal because:
- Proof was already validated on Hub
- Nullifiers were already marked on Hub
- Client just needs to know where to send the USDC

---

## Implementation Phases

### Phase 1: Storage Layout & Interfaces (~2 days)

**Goal**: Establish shared storage layout for Hub modules and define all interfaces.

**Files to create**:
```
contracts/privacy-pool/
├── storage/
│   └── PrivacyPoolStorage.sol    # Shared storage layout (Hub only)
├── interfaces/
│   ├── IPrivacyPool.sol          # Hub external interface
│   ├── IPrivacyPoolClient.sol    # Client external interface
│   ├── IShieldModule.sol
│   ├── ITransactModule.sol
│   ├── IMerkleModule.sol
│   └── IVerifierModule.sol
└── types/
    └── CCTPTypes.sol             # MessageType, CCTPPayload, ShieldData, UnshieldData
```

**PrivacyPoolStorage.sol**:
```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "../../railgun/logic/Globals.sol";

/**
 * @title PrivacyPoolStorage
 * @notice Shared storage layout for Hub PrivacyPool and all modules
 * @dev ALL modules inherit this. Storage slots MUST remain stable.
 *      Add new variables at the end only. Never remove or reorder.
 */
abstract contract PrivacyPoolStorage {
    // ══════════════════════════════════════════════════════════════════
    // Module addresses (Hub only)
    // ══════════════════════════════════════════════════════════════════
    address public shieldModule;
    address public transactModule;
    address public merkleModule;
    address public verifierModule;

    // ══════════════════════════════════════════════════════════════════
    // CCTP configuration
    // ══════════════════════════════════════════════════════════════════
    address public tokenMessenger;      // ITokenMessengerV2
    address public messageTransmitter;  // IMessageTransmitterV2
    address public usdc;                // USDC token address
    uint32 public localDomain;          // This chain's CCTP domain ID

    // Mapping: remote domain -> remote PrivacyPool/Client address (as bytes32)
    mapping(uint32 => bytes32) public remotePools;

    // ══════════════════════════════════════════════════════════════════
    // Treasury & Fees (deferred - all set to 0 for POC)
    // ══════════════════════════════════════════════════════════════════
    address payable public treasury;
    uint120 public shieldFee;           // Basis points (100 = 1%), default 0
    uint120 public unshieldFee;         // default 0

    // ══════════════════════════════════════════════════════════════════
    // Token management
    // ══════════════════════════════════════════════════════════════════
    mapping(address => bool) public tokenBlocklist;
    mapping(bytes32 => TokenData) public tokenIDMapping;

    // ══════════════════════════════════════════════════════════════════
    // Merkle tree state (from Commitments.sol)
    // ══════════════════════════════════════════════════════════════════
    uint256 internal constant TREE_DEPTH = 16;
    bytes32 public constant ZERO_VALUE = bytes32(uint256(keccak256("Railgun")) % SNARK_SCALAR_FIELD);

    uint256 public nextLeafIndex;
    bytes32 public merkleRoot;
    bytes32 internal newTreeRoot;
    uint256 public treeNumber;

    bytes32[TREE_DEPTH] public zeros;
    bytes32[TREE_DEPTH] internal filledSubTrees;

    // treeNumber -> root -> seen
    mapping(uint256 => mapping(bytes32 => bool)) public rootHistory;

    // treeNumber -> nullifier -> spent
    mapping(uint256 => mapping(bytes32 => bool)) public nullifiers;

    // ══════════════════════════════════════════════════════════════════
    // Verifier state
    // ══════════════════════════════════════════════════════════════════
    // nullifiers count -> commitments count -> VerifyingKey
    mapping(uint256 => mapping(uint256 => VerifyingKey)) internal verificationKeys;
    bool public testingMode;  // POC only - bypasses SNARK verification

    // ══════════════════════════════════════════════════════════════════
    // Misc
    // ══════════════════════════════════════════════════════════════════
    mapping(uint256 => bool) public snarkSafetyVector;
    uint256 public lastEventBlock;
    address public owner;
    bool public initialized;

    // ══════════════════════════════════════════════════════════════════
    // Reserved for future use
    // ══════════════════════════════════════════════════════════════════
    uint256[50] private __gap;
}
```

**Deliverables**:
- [ ] `PrivacyPoolStorage.sol` with complete storage layout
- [ ] `CCTPTypes.sol` with message types and payload structs
- [ ] Interface files for Hub modules
- [ ] Interface file for Client contract

---

### Phase 2: MerkleModule (~1-2 days)

**Goal**: Extract merkle tree logic into a module.

**Source**: `contracts/railgun/logic/Commitments.sol`

**MerkleModule.sol** (~200 lines):
```solidity
contract MerkleModule is PrivacyPoolStorage {
    function initializeMerkle() external;
    function hashLeftRight(bytes32 _left, bytes32 _right) public pure returns (bytes32);
    function insertLeaves(bytes32[] memory _leafHashes) external;
    function getInsertionTreeNumberAndStartingIndex(uint256 _newCommitments)
        external view returns (uint256, uint256);
}
```

**Deliverables**:
- [ ] `MerkleModule.sol`
- [ ] Unit tests for merkle operations

---

### Phase 3: VerifierModule (~1-2 days)

**Goal**: Extract SNARK verification into a module.

**Source**: `contracts/railgun/logic/Verifier.sol` + `Snark.sol`

**VerifierModule.sol** (~150 lines):
```solidity
contract VerifierModule is PrivacyPoolStorage {
    function setVerificationKey(uint256 _nullifiers, uint256 _commitments, VerifyingKey calldata _key) external;
    function getVerificationKey(uint256 _nullifiers, uint256 _commitments) external view returns (VerifyingKey memory);
    function verify(Transaction calldata _transaction) external view returns (bool);
    function hashBoundParams(BoundParams calldata _boundParams) public pure returns (uint256);
    function setTestingMode(bool _enabled) external;  // POC only
}
```

**Deliverables**:
- [ ] `VerifierModule.sol`
- [ ] Unit tests for verification

---

### Phase 4: ShieldModule (~2 days)

**Goal**: Implement local shield and process incoming cross-chain shields.

**Sources**:
- `RailgunSmartWallet.shield()`
- `RailgunLogic.transferTokenIn()`
- `RailgunLogic.validateCommitmentPreimage()`

**ShieldModule.sol** (~200 lines):
```solidity
contract ShieldModule is PrivacyPoolStorage {
    event Shield(
        uint256 treeNumber,
        uint256 startPosition,
        CommitmentPreimage[] commitments,
        ShieldCiphertext[] shieldCiphertext,
        uint256[] fees
    );

    /**
     * @notice Shield tokens locally (user on Hub chain)
     */
    function shield(ShieldRequest[] calldata _shieldRequests) external;

    /**
     * @notice Process incoming cross-chain shield from Client
     * @dev Called by Router when CCTP message arrives with MessageType.SHIELD
     *      USDC already minted to PrivacyPool by CCTP
     */
    function processIncomingShield(uint256 amount, ShieldData calldata data) external;

    // Internal helpers
    function _validateCommitmentPreimage(CommitmentPreimage calldata _note) internal view;
    function _transferTokenIn(CommitmentPreimage calldata _note) internal returns (CommitmentPreimage memory, uint256);
    function _hashCommitment(CommitmentPreimage memory _note) internal pure returns (bytes32);
}
```

**Deliverables**:
- [ ] `ShieldModule.sol`
- [ ] Integration tests for local shield
- [ ] Integration tests for incoming cross-chain shield

---

### Phase 5: TransactModule with Atomic Unshield (~3 days)

**Goal**: Implement transact, local unshield, and atomic cross-chain unshield.

**Sources**:
- `RailgunSmartWallet.transact()`
- `RailgunLogic.validateTransaction()`
- `RailgunLogic.accumulateAndNullifyTransaction()`
- `RailgunLogic.transferTokenOut()`

**TransactModule.sol** (~350 lines):
```solidity
contract TransactModule is PrivacyPoolStorage {
    event Transact(
        uint256 treeNumber,
        uint256 startPosition,
        bytes32[] hash,
        CommitmentCiphertext[] ciphertext
    );
    event Unshield(address to, TokenData token, uint256 amount, uint256 fee);
    event Nullified(uint16 treeNumber, bytes32[] nullifier);
    event CrossChainUnshieldInitiated(
        uint32 indexed destinationDomain,
        address indexed recipient,
        uint256 amount,
        uint64 nonce
    );

    /**
     * @notice Execute private transactions (transfers and/or local unshields)
     */
    function transact(Transaction[] calldata _transactions) external;

    /**
     * @notice Atomic cross-chain unshield
     * @dev Validates proof on Hub, nullifies, then burns via CCTP to Client
     *
     * @param _transaction Transaction with unshield proof
     * @param destinationDomain Client chain's CCTP domain
     * @param finalRecipient Address to receive USDC on client chain
     */
    function atomicCrossChainUnshield(
        Transaction calldata _transaction,
        uint32 destinationDomain,
        address finalRecipient
    ) external returns (uint64 nonce);

    // Internal helpers (from RailgunLogic)
    function _validateTransaction(Transaction calldata _tx) internal view returns (bool, string memory);
    function _accumulateAndNullify(Transaction calldata _tx, ...) internal returns (uint256);
    function _transferTokenOut(CommitmentPreimage calldata _note) internal;
}
```

**Deliverables**:
- [ ] `TransactModule.sol`
- [ ] Integration tests for transact
- [ ] Integration tests for local unshield
- [ ] Integration tests for atomic cross-chain unshield

---

### Phase 6: Hub Router (PrivacyPool.sol) (~2 days)

**Goal**: Implement the main Hub router with CCTP message handling.

**PrivacyPool.sol** (~250 lines):
```solidity
contract PrivacyPool is PrivacyPoolStorage, IMessageHandlerV2 {
    // ═══════════════════════════════════════════════════════════════════
    // Initialization
    // ═══════════════════════════════════════════════════════════════════
    function initialize(
        address _shieldModule,
        address _transactModule,
        address _merkleModule,
        address _verifierModule,
        address _tokenMessenger,
        address _messageTransmitter,
        address _usdc,
        uint32 _localDomain,
        address _owner
    ) external;

    // ═══════════════════════════════════════════════════════════════════
    // User-facing entry points (delegate to modules)
    // ═══════════════════════════════════════════════════════════════════
    function shield(ShieldRequest[] calldata _requests) external;
    function transact(Transaction[] calldata _transactions) external;
    function atomicCrossChainUnshield(
        Transaction calldata _transaction,
        uint32 destinationDomain,
        address finalRecipient
    ) external returns (uint64);

    // ═══════════════════════════════════════════════════════════════════
    // CCTP V2 Message Handler (receives cross-chain shields from Clients)
    // ═══════════════════════════════════════════════════════════════════
    function handleReceiveFinalizedMessage(
        uint32 remoteDomain,
        bytes32 sender,
        uint32 finalityThresholdExecuted,
        bytes calldata messageBody
    ) external returns (bool);

    // ═══════════════════════════════════════════════════════════════════
    // Admin
    // ═══════════════════════════════════════════════════════════════════
    function setRemotePool(uint32 domain, bytes32 poolAddress) external;
    function setVerificationKey(uint256 nullifiers, uint256 commitments, VerifyingKey calldata key) external;
    function setTestingMode(bool enabled) external;

    // ═══════════════════════════════════════════════════════════════════
    // Internal
    // ═══════════════════════════════════════════════════════════════════
    function _delegatecall(address module, bytes memory data) internal returns (bytes memory);
}
```

**Deliverables**:
- [ ] `PrivacyPool.sol` Hub router
- [ ] End-to-end tests for Hub operations

---

### Phase 7: Client Contract (PrivacyPoolClient.sol) (~1-2 days)

**Goal**: Implement the thin Client bridge contract.

**PrivacyPoolClient.sol** (~150 lines):
```solidity
contract PrivacyPoolClient is IMessageHandlerV2 {
    // Configuration (no complex storage needed)
    address public tokenMessenger;
    address public messageTransmitter;
    address public usdc;
    uint32 public localDomain;
    uint32 public hubDomain;
    bytes32 public hubPool;  // Hub PrivacyPool address as bytes32
    address public owner;

    event CrossChainShieldInitiated(
        address indexed sender,
        uint256 amount,
        bytes32 npk,
        uint64 nonce
    );
    event UnshieldReceived(
        address indexed recipient,
        uint256 amount
    );

    /**
     * @notice Initiate cross-chain shield to Hub
     * @param amount Amount of USDC to shield
     * @param npk Note public key
     * @param encryptedBundle Encrypted note data
     * @param shieldKey Shield key for decryption
     */
    function crossChainShield(
        uint256 amount,
        bytes32 npk,
        bytes32[3] calldata encryptedBundle,
        bytes32 shieldKey
    ) external returns (uint64 nonce) {
        // Transfer USDC from user
        IERC20(usdc).safeTransferFrom(msg.sender, address(this), amount);

        // Encode shield payload
        bytes memory hookData = abi.encode(
            CCTPPayload({
                messageType: MessageType.SHIELD,
                data: abi.encode(ShieldData({
                    npk: npk,
                    value: uint120(amount),
                    encryptedBundle: encryptedBundle,
                    shieldKey: shieldKey
                }))
            })
        );

        // Burn via CCTP
        IERC20(usdc).safeApprove(tokenMessenger, amount);
        nonce = ITokenMessengerV2(tokenMessenger).depositForBurnWithHook(
            amount,
            hubDomain,
            hubPool,
            usdc,
            bytes32(0),
            0,
            CCTPFinality.STANDARD,
            hookData
        );

        emit CrossChainShieldInitiated(msg.sender, amount, npk, nonce);
    }

    /**
     * @notice Handle incoming CCTP message (atomic unshields from Hub)
     */
    function handleReceiveFinalizedMessage(
        uint32 remoteDomain,
        bytes32 sender,
        uint32,
        bytes calldata messageBody
    ) external returns (bool) {
        require(msg.sender == messageTransmitter, "Only MessageTransmitter");
        require(remoteDomain == hubDomain, "Only from Hub");
        require(sender == hubPool, "Only from Hub Pool");

        // Decode message - USDC already minted to this contract
        (, , uint256 amount, bytes memory hookData) = BurnMessage.decode(messageBody);

        // Decode our payload
        CCTPPayload memory payload = abi.decode(hookData, (CCTPPayload));
        require(payload.messageType == MessageType.UNSHIELD, "Invalid message type");

        UnshieldData memory data = abi.decode(payload.data, (UnshieldData));

        // Transfer USDC to final recipient
        IERC20(usdc).safeTransfer(data.recipient, amount);

        emit UnshieldReceived(data.recipient, amount);
        return true;
    }

    // Admin functions
    function setHubPool(uint32 _hubDomain, bytes32 _hubPool) external;
}
```

**Deliverables**:
- [ ] `PrivacyPoolClient.sol`
- [ ] Integration tests for cross-chain shield initiation
- [ ] Integration tests for unshield reception

---

### Phase 8: Mock CCTP Updates (~2 days)

**Goal**: Update Mock CCTP to closely simulate real CCTP V2 behavior.

**Requirements**:
1. Implement `ITokenMessengerV2.depositForBurnWithHook()` (not just `depositForBurn`)
2. Implement `IMessageHandlerV2` callback pattern
3. Simulate attestation delay (optional, for realistic testing)
4. Use real CCTP domain IDs where possible
5. Maintain compatibility with real CCTP interfaces for eventual testnet deployment

**MockTokenMessengerV2.sol**:
```solidity
contract MockTokenMessengerV2 is ITokenMessengerV2 {
    function depositForBurn(...) external returns (uint64 nonce);
    function depositForBurnWithHook(..., bytes calldata hookData) external returns (uint64 nonce);
}
```

**MockMessageTransmitterV2.sol**:
```solidity
contract MockMessageTransmitterV2 is IMessageTransmitterV2 {
    function receiveMessage(bytes calldata message, bytes calldata attestation) external returns (bool);
    function localDomain() external view returns (uint32);
}
```

**Deliverables**:
- [ ] `MockTokenMessengerV2.sol`
- [ ] `MockMessageTransmitterV2.sol`
- [ ] Relayer updates to use new mock contracts

---

### Phase 9: Deployment & Integration (~2-3 days)

**Goal**: Deploy scripts, relayer updates, SDK integration.

**Deployment script** (`scripts/deploy_privacy_pool.ts`):
```typescript
async function deployHub(hre: HardhatRuntimeEnvironment) {
    // Deploy modules
    const merkleModule = await deploy("MerkleModule");
    const verifierModule = await deploy("VerifierModule");
    const shieldModule = await deploy("ShieldModule");
    const transactModule = await deploy("TransactModule");

    // Deploy mock CCTP (or use real addresses on testnet)
    const mockMessenger = await deploy("MockTokenMessengerV2", [...]);
    const mockTransmitter = await deploy("MockMessageTransmitterV2", [...]);

    // Deploy Hub router
    const privacyPool = await deploy("PrivacyPool");
    await privacyPool.initialize(
        shieldModule.address,
        transactModule.address,
        merkleModule.address,
        verifierModule.address,
        mockMessenger.address,
        mockTransmitter.address,
        usdc.address,
        HUB_DOMAIN,
        owner
    );

    // Set verification keys
    await privacyPool.setVerificationKey(1, 2, vk_1x2);
    await privacyPool.setVerificationKey(2, 2, vk_2x2);
    // ...

    return { privacyPool, modules: { merkle, verifier, shield, transact } };
}

async function deployClient(hre: HardhatRuntimeEnvironment, hubDomain: number, hubPool: string) {
    const mockMessenger = await deploy("MockTokenMessengerV2", [...]);
    const mockTransmitter = await deploy("MockMessageTransmitterV2", [...]);

    const client = await deploy("PrivacyPoolClient");
    await client.initialize(
        mockMessenger.address,
        mockTransmitter.address,
        usdc.address,
        CLIENT_DOMAIN,
        hubDomain,
        hubPool
    );

    return client;
}
```

**SDK integration**:
- Update `shield.ts` to support both local and cross-chain shield
- Add `atomicUnshield.ts` for cross-chain unshield from Hub

**Deliverables**:
- [ ] `deploy_privacy_pool.ts` script
- [ ] Updated relayer for new message format
- [ ] SDK integration
- [ ] End-to-end multi-chain tests

---

## File Structure (Final)

```
contracts/privacy-pool/
├── PrivacyPool.sol                     # Hub Router (~250 lines, ~8 KB)
├── PrivacyPoolClient.sol               # Client Bridge (~150 lines, ~4 KB)
├── storage/
│   └── PrivacyPoolStorage.sol          # Hub shared storage (~120 lines)
├── modules/
│   ├── ShieldModule.sol                # Shield logic (~200 lines, ~6 KB)
│   ├── TransactModule.sol              # Transact + unshield (~350 lines, ~10 KB)
│   ├── MerkleModule.sol                # Merkle tree (~200 lines, ~6 KB)
│   └── VerifierModule.sol              # SNARK verify (~150 lines, ~5 KB)
├── interfaces/
│   ├── IPrivacyPool.sol
│   ├── IPrivacyPoolClient.sol
│   ├── IShieldModule.sol
│   ├── ITransactModule.sol
│   ├── IMerkleModule.sol
│   └── IVerifierModule.sol
├── types/
│   └── CCTPTypes.sol                   # Message types, payloads
└── mocks/
    ├── MockTokenMessengerV2.sol        # CCTP V2 mock
    └── MockMessageTransmitterV2.sol    # CCTP V2 mock
```

---

## Testing Strategy

### Unit Tests
- [ ] MerkleModule: insert, hash, tree rollover
- [ ] VerifierModule: key setting, proof verification, testing mode bypass
- [ ] ShieldModule: local shield, incoming shield processing
- [ ] TransactModule: transact, local unshield, atomic unshield encoding

### Integration Tests (Single Chain)
- [ ] Hub: shield → transfer → local unshield
- [ ] Hub: CCTP message reception and shield processing

### E2E Tests (Multi-Chain)
- [ ] Deploy Hub + 2 Clients on local Anvil instances
- [ ] Client A → Hub cross-chain shield
- [ ] Hub transfer (private)
- [ ] Hub → Client B atomic unshield
- [ ] Full cycle: shield on Client A → transfer on Hub → unshield to Client B

---

## Timeline Summary

| Phase | Scope | Effort |
|-------|-------|--------|
| 1 | Storage layout & interfaces | 2 days |
| 2 | MerkleModule | 1-2 days |
| 3 | VerifierModule | 1-2 days |
| 4 | ShieldModule | 2 days |
| 5 | TransactModule + atomic unshield | 3 days |
| 6 | Hub Router (PrivacyPool.sol) | 2 days |
| 7 | Client Contract (PrivacyPoolClient.sol) | 1-2 days |
| 8 | Mock CCTP V2 updates | 2 days |
| 9 | Deployment & integration | 2-3 days |
| **Total** | | **~16-20 days** |

---

## Design Decisions

### Why Hub validates, Client trusts?

In the hub/client model:
- All shielded state (merkle tree, nullifiers) lives on Hub
- Only Hub can validate proofs (needs merkle root history)
- Client has no state to validate against

When Hub sends atomic unshield via CCTP:
1. Hub already validated the proof
2. Hub already nullified the inputs (preventing double-spend)
3. CCTP guarantees message authenticity (attestation)
4. Client just needs to forward USDC to recipient

### Why separate Client contract?

Could we use the same PrivacyPool.sol on clients? No, because:
- Client doesn't need merkle tree, nullifiers, verifier
- Client would waste gas deploying unused modules
- Client has fundamentally different role (bridge vs. privacy pool)
- Simpler Client = smaller attack surface

### Why Mock CCTP should match real interfaces?

For eventual testnet deployment:
- Same contract code works with real CCTP
- Just change constructor args (messenger/transmitter addresses)
- No code changes needed when moving from local → testnet → mainnet
