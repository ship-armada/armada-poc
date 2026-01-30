# Current Architecture vs CCTP-Native Rework

## Current Architecture Summary

### Contract Topology

```
CLIENT CHAINS (31338, 31339)              HUB CHAIN (31337)
┌─────────────────────────────┐           ┌─────────────────────────────────────────┐
│                             │           │                                         │
│  MockUSDC                   │           │  MockUSDC                               │
│    └── burnForDeposit()     │           │    └── receiveMessage()                 │
│                             │           │          └── calls onCCTPReceive()      │
│  ClientShieldProxyV2        │           │                                         │
│    └── shield()             │           │  HubCCTPReceiverV2                      │
│          - takes USDC       │           │    └── onCCTPReceive()                  │
│          - encodes payload  │           │          - decodes payload              │
│          - burns via CCTP   │──────────▶│          - constructs ShieldRequest     │
│                             │  Relayer  │          - calls Railgun.shield()       │
│                             │           │                                         │
│                             │           │  RailgunSmartWallet                     │
│                             │           │    ├── shield() - no proof required     │
│                             │           │    └── transact() - ZK proof required   │
│                             │           │          - validates proof              │
│                             │           │          - nullifies inputs             │
│                             │           │          - inserts new commitments      │
│                             │           │          - handles unshields            │
│                             │           │                                         │
│  MockUSDC                   │           │  HubUnshieldProxy                       │
│    └── receiveMessage()     │◀──────────│    └── bridgeTo()                       │
│          - mints to user    │  Relayer  │          - burns USDC via CCTP          │
│                             │           │                                         │
└─────────────────────────────┘           └─────────────────────────────────────────┘
```

### Data Flow: Shield (Client → Hub)

1. **User generates ShieldRequest off-chain** (via SDK)
   - Creates `npk = Poseidon(Poseidon(spendingPubKey, nullifyingKey), random)`
   - Encrypts bundle with recipient's viewing key

2. **User calls `ClientShieldProxyV2.shield(amount, npk, encryptedBundle, shieldKey)`**
   - Contract pulls USDC from user
   - Encodes payload: `abi.encode(npk, amount, encryptedBundle, shieldKey)`
   - Calls `MockUSDC.burnForDeposit(amount, hubChainId, hubReceiver, payload)`
   - Emits `BurnForDeposit` event

3. **Relayer watches for `BurnForDeposit` events**
   - Calls `MockUSDC.receiveMessage(sourceChain, nonce, recipient, amount, payload)` on Hub

4. **Hub MockUSDC mints to HubCCTPReceiverV2, then calls `onCCTPReceive(amount, payload)`**
   - Decodes payload into npk, amount, encryptedBundle, shieldKey
   - Constructs `ShieldRequest` struct
   - Approves RailgunSmartWallet
   - Calls `RailgunSmartWallet.shield(requests)`

5. **RailgunSmartWallet.shield()**
   - Validates preimage (amount > 0, npk in field, token not blocklisted)
   - Pulls USDC from caller (HubCCTPReceiverV2)
   - Computes commitment hash: `Poseidon(npk, tokenId, value)`
   - Inserts into merkle tree
   - Emits `Shield` event with encrypted ciphertext

### Data Flow: Transfer (Hub internal)

1. **User generates ZK proof off-chain** (via SDK)
   - Proves knowledge of note(s) in tree (spending key, nullifying key)
   - Proves output commitments are correctly formed
   - Creates nullifiers for spent notes

2. **User/Relayer calls `RailgunSmartWallet.transact(transactions)`**
   - Validates merkle root is historical
   - Verifies Groth16 SNARK proof
   - Checks nullifiers haven't been spent
   - Marks nullifiers as spent
   - Inserts new commitments into tree
   - Emits `Transact` event with ciphertexts

### Data Flow: Unshield (Hub → Client)

1. **User generates unshield proof off-chain**
   - Same as transfer, but last commitment encodes recipient address in `npk` field
   - Sets `boundParams.unshield = UnshieldType.NORMAL`

2. **User calls `RailgunSmartWallet.transact()`**
   - Validates and processes as above
   - Calls `transferTokenOut()` for unshield commitment
   - Sends USDC to recipient address (encoded in npk)

3. **User manually bridges** (current POC approach)
   - Receives USDC on Hub
   - Approves and calls `HubUnshieldProxy.bridgeTo(amount, recipient, destChainId)`
   - Proxy burns via CCTP
   - Relayer mints on destination chain

---

## Key Observations About Current Design

### What the Proxy Contracts Do

| Contract | Role | Limitations |
|----------|------|-------------|
| `ClientShieldProxyV2` | Encodes plaintext payload, initiates CCTP burn | Payload is plaintext (npk, amount visible to relayer) |
| `HubCCTPReceiverV2` | Decodes payload, calls Railgun shield | Just a translation layer |
| `HubUnshieldProxy` | Initiates CCTP burn for cross-chain withdrawal | Requires manual user action after unshield |

### What Railgun Contracts Do

| Contract | Role | Key Points |
|----------|------|------------|
| `RailgunSmartWallet` | Entry point for shield/transact | Shield has no proof, transact requires proof |
| `RailgunLogic` | Core validation, token transfers, fee handling | Proof verification, nullifier management |
| `Commitments` | Merkle tree management | 16-depth Poseidon tree, root history |
| `Verifier` | Groth16 proof verification | Calls precompile for pairing check |

### The Privacy Boundary

```
PLAINTEXT ZONE                    │  PRIVATE ZONE
                                  │
User wallet address               │  npk (note public key)
Amount being shielded             │  Spending key
CCTP message contents             │  Nullifying key
                                  │  Note values (after shield)
                                  │  Transfer recipients
```

The current architecture exposes the shield payload (npk, amount) to the relayer. The privacy only begins once funds enter the merkle tree.

---

## CCTP-Native Rework

### Goal

Collapse the proxy layer. Make the privacy pool contract the direct recipient of CCTP messages, with CCTP semantics built into the core protocol.

### Proposed Contract Topology

```
ALL CHAINS (unified contract)
┌───────────────────────────────────────────────────────────────────┐
│                                                                   │
│  CCTP MessageTransmitter / TokenMessenger                        │
│    └── Standard CCTP infrastructure                              │
│                                                                   │
│  PrivacyPool.sol (replaces all proxies + Railgun contracts)      │
│    │                                                              │
│    ├── receiveMessage()           ← CCTP entry point              │
│    │     └── Routes based on messageType                          │
│    │                                                              │
│    ├── shield()                   ← Local shield (same chain)     │
│    │     └── Takes USDC, creates commitment                       │
│    │                                                              │
│    ├── transact()                 ← Private transfer/unshield     │
│    │     └── Verifies proof, processes nullifiers/commitments     │
│    │                                                              │
│    ├── crossChainTransfer()       ← Initiate cross-chain send     │
│    │     └── Burns via CCTP with proof payload                    │
│    │                                                              │
│    └── syncRoot()                 ← Receive merkle root from      │
│          └── other chain (for cross-chain MASP)                   │
│                                                                   │
│  Merkle Tree State                                                │
│    ├── commitments[]              (local tree)                    │
│    ├── nullifiers{}               (spent notes)                   │
│    └── foreignRoots{}             (attested roots from other      │
│                                    chains, for cross-chain proofs)│
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

### Changes Required

#### 1. Contract Changes

**Merge proxy logic into core contract:**

```solidity
// Current: 4 separate contracts
ClientShieldProxyV2.sol   → absorbed
HubCCTPReceiverV2.sol     → absorbed
HubUnshieldProxy.sol      → absorbed
RailgunSmartWallet.sol    → becomes PrivacyPool.sol

// New: Single unified contract per chain
PrivacyPool.sol
```

**New unified message format:**

```solidity
enum MessageType {
    SHIELD,              // Cross-chain shield (commitment data in payload)
    TRANSFER,            // Cross-chain transfer (proof + commitment in payload)
    UNSHIELD,            // Cross-chain unshield (proof + recipient in payload)
    SYNC_ROOT            // Merkle root attestation (for cross-chain MASP)
}

struct CCTPPayload {
    MessageType messageType;
    bytes32[] nullifiers;        // Empty for shield
    bytes32[] commitments;       // New UTXOs
    bytes proof;                 // ZK proof (empty for shield)
    bytes encryptedData;         // Ciphertext for recipients
}
```

**Direct CCTP integration:**

```solidity
contract PrivacyPool is IMessageHandler {
    ITokenMessenger public tokenMessenger;

    // Called by CCTP when message arrives
    function handleReceiveMessage(
        uint32 sourceDomain,
        bytes32 sender,
        bytes calldata messageBody
    ) external returns (bool) {
        require(msg.sender == address(messageTransmitter));

        CCTPPayload memory payload = abi.decode(messageBody, (CCTPPayload));

        if (payload.messageType == MessageType.SHIELD) {
            _processShield(payload);
        } else if (payload.messageType == MessageType.TRANSFER) {
            _processCrossChainTransfer(sourceDomain, payload);
        } else if (payload.messageType == MessageType.SYNC_ROOT) {
            _processRootSync(sourceDomain, payload);
        }

        return true;
    }

    // Initiate cross-chain transfer
    function crossChainTransfer(
        uint32 destDomain,
        bytes32[] calldata nullifiers,
        bytes32[] calldata commitments,
        bytes calldata proof,
        bytes calldata encryptedData
    ) external {
        // Verify proof locally first
        require(_verifyProof(nullifiers, commitments, proof), "Invalid proof");

        // Mark nullifiers as spent locally
        _nullify(nullifiers);

        // Encode payload
        CCTPPayload memory payload = CCTPPayload({
            messageType: MessageType.TRANSFER,
            nullifiers: nullifiers,
            commitments: commitments,
            proof: proof,
            encryptedData: encryptedData
        });

        // Send via CCTP (proof is verified on dest chain too, or trusted via attestation)
        tokenMessenger.depositForBurnWithCaller(
            amount,
            destDomain,
            destinationPool,
            address(usdc),
            abi.encode(payload)
        );
    }
}
```

#### 2. Circuit Changes

For basic CCTP-native (hub model), **no circuit changes required**. The existing Railgun circuits work:
- Transfer circuit: proves spending authority, creates new commitments
- The only change is that `destChainId` becomes a public input bound to the proof

For cross-chain MASP (mesh model), circuits need modification:

```
// Current circuit public inputs:
- merkleRoot (single tree)
- nullifiers[]
- commitments[]
- boundParams hash

// New circuit public inputs for cross-chain:
- sourceChainId
- destChainId
- merkleRoot (could be from any attested chain)
- nullifiers[]
- commitments[]
- boundParams hash
```

The circuit would need to:
1. Accept merkle proofs against roots from any chain in the attested set
2. Bind the proof to specific source/dest chains (prevents replay)
3. Include CCTP nonce in bound params (optional, for atomicity)

#### 3. What Stays the Same

- **Commitment structure**: `Poseidon(npk, tokenId, value)` - unchanged
- **Nullifier derivation**: `Poseidon(nullifyingKey, leafIndex)` - unchanged
- **Merkle tree**: 16-depth Poseidon incremental tree - unchanged
- **Proof system**: Groth16 over BN254 - unchanged (could upgrade to Plonk later)
- **Key derivation**: Spending key, viewing key, nullifying key hierarchy - unchanged

---

## Comparison: Current vs CCTP-Native

| Aspect | Current (Proxy) | CCTP-Native |
|--------|-----------------|-------------|
| Contract count per chain | 4+ (proxies + Railgun) | 1 (PrivacyPool) |
| Shield flow | User → Proxy → CCTP → Receiver → Railgun | User → PrivacyPool ←→ CCTP |
| Unshield flow | Railgun → User → Proxy → CCTP | PrivacyPool → CCTP (atomic) |
| Cross-chain message | Contains plaintext (npk, amount) | Contains proof + commitments |
| Relayer can see | Shield amounts, recipient npk | Nothing useful (just ciphertext) |
| Atomic cross-chain | No (manual bridge step) | Yes (proof in message) |
| Circuit changes | None | None for hub, significant for mesh |

---

## Implementation Phases

### Phase 1: Contract Consolidation (No Circuit Changes)

1. Create `PrivacyPool.sol` that combines:
   - Merkle tree management (from Commitments.sol)
   - Proof verification (from Verifier.sol)
   - Token handling (from RailgunLogic.sol)
   - CCTP message handling (replaces proxies)

2. Implement direct CCTP integration:
   - Contract is the CCTP message recipient
   - `handleReceiveMessage()` routes to shield/transfer handlers

3. Unify message format:
   - Single payload structure for all message types
   - Proof included in cross-chain messages

4. Keep using Railgun circuits (no changes needed for hub model)

### Phase 2: Cross-Chain MASP (Circuit Changes Required)

1. Modify circuits to accept:
   - Chain ID as public input
   - Merkle roots from multiple chains

2. Implement root synchronization:
   - Each chain broadcasts its merkle root via CCTP
   - Chains store attested roots from other chains
   - Proofs can reference any attested root

3. Solve nullifier synchronization:
   - Option A: Pessimistic (wait for all chains to confirm)
   - Option B: Optimistic (challenge period)
   - Option C: Designated nullifier chain

---

## Questions to Resolve

1. **Hub vs Mesh**: Is the hub model acceptable, or is true cross-chain MASP required?
   - Hub is simpler (Phase 1 only)
   - Mesh requires Phase 2 circuit work

2. **Proof verification location**: Should cross-chain proofs be verified on:
   - Source chain only (dest trusts CCTP attestation)
   - Destination chain only (source just sends data)
   - Both chains (redundant but maximally secure)

3. **Atomicity**: How to handle failed cross-chain transfers?
   - Timeout + reclaim mechanism?
   - Two-phase commit?

4. **CCTP v2 specifics**: Are there v2 features (hooks, etc.) that change the integration pattern?
