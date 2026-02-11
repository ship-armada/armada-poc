# Cross-Chain Privacy Protocol: Architecture Notes

## Current State

The POC uses Railgun contracts as a shortcut to get a working demo before custom circuits/verifiers are built. The current architecture uses a hub-spoke model with CCTP simulation via proxy contracts.

### Current Flow
```
User → ClientShieldProxy → MockUSDC.burn() → [Relayer] → HubReceiver → RailgunWallet.shield()
```

The privacy boundary starts *after* the bridge. Cross-chain messages are plaintext (amount, recipient NPK, encrypted bundle).

---

## Target Features

- USDC focused
- CCTP integration at a fundamental level
- Convert circuit (if feasible)
- Native Aave vault integration - deposit USDC from shielded pool, receive yield back into shielded pool

---

## Deep CCTP Integration

### Why Integrate CCTP Into Core Contracts/Proofs?

There are meaningful advantages to deep CCTP integration, especially for building toward a cross-chain MASP.

### Option A: CCTP-Aware Commitments

Encode the cross-chain intent *inside* the commitment/proof:
```
Commitment = Poseidon(npk, token, amount, destChainId, bridgeNonce)
```

The proof itself attests to the cross-chain transfer validity:
- Relayer can't modify destination or amount
- Can prove cross-chain transfers were valid without revealing details
- Enables atomic cross-chain operations (if chain B doesn't confirm, chain A can reclaim)

### Option B: Unified Message Format

Make commitment scheme and CCTP messages share structure:
```solidity
// The shield request IS the CCTP message payload format
struct UnifiedMessage {
    bytes32 nullifier;      // For spending (if transfer/unshield)
    bytes32 commitment;     // New UTXO
    bytes32 merkleRoot;     // Which tree state we're proving against
    uint32 destDomain;      // CCTP destination
    bytes proof;            // ZK proof covering all of the above
}
```

This collapses the proxy layer into the core protocol.

### Advantages for Cross-Chain MASP

1. **Merkle Root Synchronization**: Include merkle root attestations in CCTP messages. Each chain maintains its own tree but accepts proofs against other chains' roots (verified via CCTP attestation).

2. **Atomic Cross-Chain Transfers**: A proof on chain A can commit to "this nullifier is spent AND this commitment appears on chain B's tree." The CCTP message carries the proof; chain B verifies and inserts.

3. **No Trusted Hub**: Any chain can verify proofs against any other chain's state without a central coordinator.

4. **Simpler Relayer**: The relayer becomes a dumb pipe - it can't understand or modify the private payload, just ferry CCTP messages.

---

## Convert Circuit + Aave Integration

### Approach 1: Convert Circuit for Yield Tokens

```
Shielded USDC → [Convert Proof] → Shielded aUSDC
                     ↓
            (Public: deposit USDC into Aave)
            (Public: receive aUSDC)
                     ↓
Shielded aUSDC → [Convert Proof] → Shielded USDC (with yield)
```

The convert circuit proves:
- Input: commitment to X USDC
- Output: commitment to Y aUSDC
- Public: X USDC deposited, Y aUSDC received
- Constraint: the exchange is valid per Aave's rate

**Challenge:** The deposit/withdrawal is public. An observer sees "someone deposited X USDC and someone withdrew Y aUSDC" - they can correlate by timing/amount.

### Approach 2: Pooled Yield (Better Privacy)

Instead of individual Aave deposits:

```
┌─────────────────────────────────────────┐
│  Shielded Pool                          │
│  ┌─────────────────────────────────────┐│
│  │  User Commitments (private)         ││
│  │  - Alice: 1000 USDC                 ││
│  │  - Bob: 500 USDC                    ││
│  └─────────────────────────────────────┘│
│              ↓                          │
│  Pool Treasury deposits ALL idle USDC   │
│  into Aave (public, but aggregated)     │
│              ↓                          │
│  Yield accrues to pool                  │
│              ↓                          │
│  Convert circuit distributes yield      │
│  proportionally to commitments          │
└─────────────────────────────────────────┘
```

The convert circuit proves:
- "My share of the pool yield is X, based on my commitment's value and duration"
- Without revealing which commitment is yours

**This is closer to Namada's approach** - the protocol itself manages yield, and users claim their share privately.

---

## Architecture Sketch: CCTP-Native Privacy Protocol

```
┌────────────────────────────────────────────────────────────────┐
│                     Core Protocol Layer                         │
├────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Commitment = Poseidon(npk, tokenType, amount, chainId, nonce)  │
│                                                                  │
│  Circuits:                                                       │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │   Transfer   │  │   Convert    │  │   CrossChainTransfer │  │
│  │              │  │              │  │                      │  │
│  │ nullifier(s) │  │ nullifier    │  │ nullifier            │  │
│  │ → commit(s)  │  │ → commit     │  │ → destChain + commit │  │
│  │ same chain   │  │ token swap   │  │ includes CCTP nonce  │  │
│  └──────────────┘  └──────────────┘  └──────────────────────┘  │
│                                                                  │
├────────────────────────────────────────────────────────────────┤
│                     CCTP Integration Layer                       │
├────────────────────────────────────────────────────────────────┤
│                                                                  │
│  On-chain: PrivacyPool.sol                                      │
│  - Receives CCTP messages directly (is the recipient)           │
│  - Verifies ZK proofs embedded in message payload               │
│  - Maintains merkle tree + nullifier set                        │
│  - Broadcasts merkle roots via CCTP to other chains             │
│                                                                  │
│  Message format:                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ CCTPMessage {                                            │   │
│  │   srcDomain, destDomain, nonce,                         │   │
│  │   payload: {                                             │   │
│  │     messageType: TRANSFER | SYNC_ROOT | CONVERT,        │   │
│  │     proof: bytes,                                        │   │
│  │     publicInputs: bytes32[],                            │   │
│  │     encryptedData: bytes  // for recipient              │   │
│  │   }                                                      │   │
│  │ }                                                        │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                  │
├────────────────────────────────────────────────────────────────┤
│                     Yield Layer (Optional)                       │
├────────────────────────────────────────────────────────────────┤
│                                                                  │
│  YieldManager.sol (or integrated into PrivacyPool)              │
│  - Deposits pool USDC into Aave                                 │
│  - Tracks yield accumulation                                    │
│  - Provides oracle for Convert circuit (yield rate)             │
│                                                                  │
│  Convert circuit for yield:                                      │
│  - Prove: I have commitment C with value V from time T          │
│  - Prove: Current time is T', yield rate is R                   │
│  - Output: New commitment C' with value V + (V * R * (T'-T))    │
│                                                                  │
└────────────────────────────────────────────────────────────────┘
```

---

## Cross-Chain MASP Architecture

For true cross-chain (not hub):

```
Chain A                          Chain B
┌──────────┐                    ┌──────────┐
│ Tree A   │                    │ Tree B   │
│ Root: Ra │─── CCTP ──────────→│ Accepts  │
│          │    (Ra attestation)│ proofs   │
│          │                    │ vs Ra    │
│          │←── CCTP ───────────│ Root: Rb │
│ Accepts  │    (Rb attestation)│          │
│ proofs   │                    │          │
│ vs Rb    │                    │          │
└──────────┘                    └──────────┘
```

Each chain:
1. Maintains its own merkle tree
2. Broadcasts its root via CCTP periodically
3. Accepts proofs against *any* chain's recently-attested root
4. Nullifiers are global (shared via CCTP or stored on each chain)

### Nullifier Synchronization Challenge

Preventing double-spends across chains is the hard part. Options:

| Approach | Description | Trade-off |
|----------|-------------|-----------|
| **Pessimistic** | Nullifier must be registered on all chains before transfer completes | Slow, but safe |
| **Optimistic** | Accept transfer, challenge period for fraud proofs | Fast, but complex |
| **Hub nullifier set** | One chain is the nullifier authority | Simpler, slight centralization |

---

## Feasibility Assessment

| Feature | Feasibility | Complexity | Notes |
|---------|-------------|------------|-------|
| Custom circuits (basic transfer) | High | Medium | Well-understood, good tooling |
| CCTP-native integration | High | Medium | Mostly contract architecture |
| Convert circuit (basic swap) | High | Medium | Similar to transfer with rate oracle |
| Convert for Aave yield | Medium | High | Needs yield accounting, timing proofs |
| Cross-chain MASP (hub model) | High | Medium | Current architecture extends naturally |
| Cross-chain MASP (true mesh) | Medium | Very High | Nullifier sync is the hard part |

---

## Recommended Implementation Order

1. **CCTP-native contract architecture** - Refactor contracts so the privacy pool *is* the CCTP recipient, not proxied. Low effort, sets up everything else.

2. **Custom transfer circuit** - Replace Railgun's circuits with custom ones. Keep it simple initially (just transfer, no convert). Full control over the system.

3. **Add convert circuit for yield** - Once transfer works, extend with convert. Start with pooled yield model for better privacy.

4. **Cross-chain MASP** - Decide hub vs mesh based on trust assumptions. Hub is pragmatic; mesh is more decentralized but significantly harder.

---

## Open Questions

- Hub vs mesh architecture decision
- Nullifier synchronization strategy for cross-chain
- Yield distribution mechanism details
- Circuit proving system choice (Groth16 vs Plonk/Halo2)
