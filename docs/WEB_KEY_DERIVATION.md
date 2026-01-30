# Web App Key Derivation Implementation Plan

## Overview

This document outlines the implementation plan for deriving shielded wallet keys from MetaMask signatures. This approach is suitable for POC/testnet use but has known security limitations for production (see Security Considerations below).

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        User's Browser                            │
│                                                                  │
│  ┌─────────────────┐      ┌─────────────────────────────────┐   │
│  │    MetaMask     │      │         Web App                  │   │
│  │                 │      │                                  │   │
│  │  EOA: 0xABC...  │◄────►│  1. Request signature            │   │
│  │                 │      │  2. Derive keys from sig         │   │
│  │  Signs message  │      │  3. Use keys for operations      │   │
│  │                 │      │  4. Zeroize when done            │   │
│  └─────────────────┘      └─────────────────────────────────┘   │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Key Derivation Flow

### Step 1: Construct Deterministic Message

The message must be:
- Deterministic (same message = same keys every time)
- Domain-separated (can't be replayed on other apps)
- Version-tagged (allows key rotation in future)
- **Chain-agnostic** (same shielded identity across all chains)

```typescript
interface KeyDerivationMessage {
  domain: "railgun-poc";
  version: 1;
  account: string;        // The EOA address (checksummed)
}

// Example message for signing (EIP-191 personal_sign)
// NOTE: No chain ID - we want the same shielded identity across all chains.
// Chain-specific logic is handled at the contract/proof level, not key derivation.
const message = `Railgun POC Key Derivation

Domain: railgun-poc
Version: 1
Account: ${checksummedAddress}

WARNING: Only sign this message on the official Railgun POC app.
Signing this message will derive your private shielded wallet keys.
`;
```

### Step 2: Request Signature from MetaMask

```typescript
async function requestKeyDerivationSignature(
  provider: ethers.BrowserProvider,
  account: string
): Promise<string> {
  const signer = await provider.getSigner();

  const message = constructDerivationMessage(account);

  // EIP-191 personal_sign
  const signature = await signer.signMessage(message);

  return signature;
}
```

### Step 3: Derive Keys from Signature

```typescript
import { keccak256, hkdf } from "ethereum-cryptography/...";

interface DerivedKeys {
  spendingKey: Uint8Array;  // 32 bytes, BN254/BLS12-381 scalar
  viewingKey: Uint8Array;   // 32 bytes
  nullifierKey: Uint8Array; // 32 bytes (may derive from spending key)
}

function deriveKeysFromSignature(signature: string): DerivedKeys {
  // Signature is 65 bytes: r (32) + s (32) + v (1)
  const sigBytes = ethers.getBytes(signature);

  // Use HKDF to derive multiple keys from signature
  // Salt should be constant and unique to this application
  const salt = ethers.toUtf8Bytes("railgun-poc-v1-key-derivation");

  // IKM (Input Key Material) is the signature
  const ikm = sigBytes;

  // Derive spending key
  const spendingKey = hkdf(
    "sha256",
    ikm,
    salt,
    ethers.toUtf8Bytes("spending-key"),
    32
  );

  // Derive viewing key
  const viewingKey = hkdf(
    "sha256",
    ikm,
    salt,
    ethers.toUtf8Bytes("viewing-key"),
    32
  );

  // Derive nullifier key (or derive from spending key per circuit design)
  const nullifierKey = hkdf(
    "sha256",
    ikm,
    salt,
    ethers.toUtf8Bytes("nullifier-key"),
    32
  );

  return { spendingKey, viewingKey, nullifierKey };
}
```

### Step 4: Convert to Curve Scalar

The derived bytes must be reduced to valid field elements:

```typescript
import { Fr } from "your-crypto-lib"; // e.g., snarkjs, ffjavascript

function toFieldElement(bytes: Uint8Array): bigint {
  // Interpret as big-endian integer
  const num = BigInt("0x" + Buffer.from(bytes).toString("hex"));

  // Reduce modulo field order
  // BN254 scalar field order:
  const BN254_FR_ORDER = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

  // BLS12-381 scalar field order:
  // const BLS12_381_FR_ORDER = 52435875175126190479447740508185965837690552500527637822603658699938581184513n;

  return num % BN254_FR_ORDER;
}
```

### Step 5: Compute Public Key and Address

```typescript
interface ShieldedWallet {
  spendingKey: bigint;      // Private
  viewingKey: bigint;       // Private (but less sensitive)
  publicKey: [bigint, bigint]; // Public point on curve
  shieldedAddress: string;  // Encoded public key for receiving
}

async function createShieldedWallet(signature: string): Promise<ShieldedWallet> {
  const derived = deriveKeysFromSignature(signature);

  const spendingKey = toFieldElement(derived.spendingKey);
  const viewingKey = toFieldElement(derived.viewingKey);

  // Public key = spending_key * G (generator point)
  // Use your circuit's curve library
  const publicKey = scalarMulGenerator(spendingKey);

  // Shielded address encodes the public key
  const shieldedAddress = encodeShieldedAddress(publicKey, viewingKey);

  return {
    spendingKey,
    viewingKey,
    publicKey,
    shieldedAddress,
  };
}
```

## Key Lifecycle Management

### Wallet State Machine

```
┌─────────────┐     connect      ┌──────────────┐
│             │ ───────────────► │              │
│ Disconnected│                  │  Connected   │
│             │ ◄─────────────── │  (EOA only)  │
└─────────────┘    disconnect    └──────┬───────┘
                                        │
                                        │ unlock shielded
                                        │ (sign derivation msg)
                                        ▼
                                 ┌──────────────┐
                                 │   Unlocked   │
                                 │ (keys in mem)│
                                 └──────┬───────┘
                                        │
                    ┌───────────────────┼───────────────────┐
                    │                   │                   │
                    ▼                   ▼                   ▼
             ┌────────────┐     ┌─────────────┐     ┌─────────────┐
             │  Shielding │     │  Transfering│     │ Unshielding │
             └────────────┘     └─────────────┘     └─────────────┘
                    │                   │                   │
                    └───────────────────┼───────────────────┘
                                        │
                                        ▼
                                 ┌──────────────┐
                                 │    Lock      │
                                 │ (zeroize)    │
                                 └──────────────┘
```

### React Context Implementation

```typescript
interface ShieldedWalletState {
  status: "disconnected" | "connected" | "unlocked" | "locked";
  eoaAddress: string | null;
  shieldedAddress: string | null;
  // Keys are NEVER stored in state - only in closure
}

interface ShieldedWalletContext {
  state: ShieldedWalletState;
  connect: () => Promise<void>;
  disconnect: () => void;
  unlockShieldedWallet: () => Promise<void>;
  lockShieldedWallet: () => void;
  // Operations that use keys internally
  shield: (amount: bigint, tokenAddress: string) => Promise<string>;
  transfer: (to: string, amount: bigint) => Promise<string>;
  unshield: (amount: bigint, recipient: string) => Promise<string>;
  getBalance: () => Promise<bigint>;
}
```

### Key Storage Pattern (Closure-Based)

Keys should never be stored in React state or any persistent storage:

```typescript
// KeyManager.ts - Singleton pattern with closure
let _spendingKey: bigint | null = null;
let _viewingKey: bigint | null = null;

export function setKeys(spending: bigint, viewing: bigint): void {
  _spendingKey = spending;
  _viewingKey = viewing;
}

export function getSpendingKey(): bigint {
  if (_spendingKey === null) {
    throw new Error("Wallet not unlocked");
  }
  return _spendingKey;
}

export function getViewingKey(): bigint {
  if (_viewingKey === null) {
    throw new Error("Wallet not unlocked");
  }
  return _viewingKey;
}

export function clearKeys(): void {
  // Note: In JS we can't guarantee memory is zeroed
  // This is a best-effort clearing
  _spendingKey = null;
  _viewingKey = null;
}

export function isUnlocked(): boolean {
  return _spendingKey !== null;
}
```

### Auto-Lock Behavior

```typescript
// Auto-lock after inactivity
const LOCK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

let lockTimer: NodeJS.Timeout | null = null;

function resetLockTimer(): void {
  if (lockTimer) {
    clearTimeout(lockTimer);
  }
  lockTimer = setTimeout(() => {
    clearKeys();
    // Update UI state
  }, LOCK_TIMEOUT_MS);
}

// Call resetLockTimer() on any user activity
// Clear timer and keys on page unload
window.addEventListener("beforeunload", () => {
  clearKeys();
});
```

## Integration with SDK Operations

### Shielding Flow

```typescript
async function shield(
  provider: ethers.BrowserProvider,
  amount: bigint,
  tokenAddress: string
): Promise<string> {
  // 1. Ensure wallet is unlocked
  if (!isUnlocked()) {
    throw new Error("Please unlock your shielded wallet first");
  }

  // 2. Get viewing key for commitment
  const viewingKey = getViewingKey();
  const randomness = generateSecureRandom();

  // 3. Compute commitment (this goes on-chain)
  const commitment = computeCommitment(amount, viewingKey, randomness);

  // 4. Store note locally (encrypted) for later scanning
  // This is separate from the spending key
  await storeEncryptedNote({
    amount,
    randomness,
    commitment,
    tokenAddress,
  });

  // 5. Build and send deposit transaction (standard EVM tx)
  const signer = await provider.getSigner();
  const shieldContract = new ethers.Contract(SHIELD_ADDRESS, SHIELD_ABI, signer);

  const tx = await shieldContract.deposit(tokenAddress, amount, commitment);
  return tx.hash;
}
```

### Transfer/Unshield Flow

```typescript
async function transfer(
  recipientShieldedAddress: string,
  amount: bigint
): Promise<string> {
  // 1. Must have spending key
  if (!isUnlocked()) {
    throw new Error("Please unlock your shielded wallet first");
  }

  const spendingKey = getSpendingKey();
  const viewingKey = getViewingKey();

  // 2. Find spendable notes (using viewing key to scan)
  const notes = await scanForNotes(viewingKey);
  const selectedNotes = selectNotesForAmount(notes, amount);

  // 3. Build circuit witness (spending key used here)
  const witness = {
    spendingKey,
    inputNotes: selectedNotes,
    outputAmount: amount,
    recipientPubKey: decodeShieldedAddress(recipientShieldedAddress),
    // ... other witness data
  };

  // 4. Generate ZK proof
  const { proof, publicInputs } = await generateProof(witness);

  // 5. Clear spending key from witness object
  witness.spendingKey = 0n;

  // 6. Submit transaction
  const tx = await submitShieldedTransfer(proof, publicInputs);
  return tx.hash;
}
```

## UI Components

### Unlock Prompt Component

```tsx
function UnlockShieldedWallet({ onUnlock }: { onUnlock: () => void }) {
  const [isUnlocking, setIsUnlocking] = useState(false);

  const handleUnlock = async () => {
    setIsUnlocking(true);
    try {
      await unlockShieldedWallet();
      onUnlock();
    } catch (err) {
      // User rejected signature or error
      console.error(err);
    } finally {
      setIsUnlocking(false);
    }
  };

  return (
    <div className="unlock-prompt">
      <h3>Unlock Shielded Wallet</h3>
      <p>
        Sign a message with MetaMask to derive your shielded wallet keys.
        Your keys will only be held in memory during this session.
      </p>
      <div className="warning">
        ⚠️ Only sign this message on trusted devices.
        This is POC software - use only with test funds.
      </div>
      <button onClick={handleUnlock} disabled={isUnlocking}>
        {isUnlocking ? "Waiting for signature..." : "Unlock Wallet"}
      </button>
    </div>
  );
}
```

### Wallet Status Component

```tsx
function WalletStatus() {
  const { state, lockShieldedWallet } = useShieldedWallet();

  return (
    <div className="wallet-status">
      <div className="eoa">
        EOA: {state.eoaAddress ? truncateAddress(state.eoaAddress) : "Not connected"}
      </div>
      {state.status === "unlocked" && (
        <>
          <div className="shielded">
            Shielded: {truncateAddress(state.shieldedAddress)}
          </div>
          <button onClick={lockShieldedWallet}>Lock</button>
        </>
      )}
    </div>
  );
}
```

## Security Considerations

### Known Limitations (POC Acceptable)

1. **Keys in JS memory**: Cannot guarantee zeroization due to GC, JIT copies
2. **Phishing risk**: Malicious sites could request same signature
3. **XSS vulnerability**: If app is compromised, keys can be exfiltrated
4. **Extension access**: Malicious browser extensions could read memory

### Mitigations Implemented

1. **Domain separation**: Message includes domain identifier
2. **Version tagging**: Allows key rotation via new version
3. **Auto-lock**: Keys cleared after inactivity
4. **Page unload clearing**: Best-effort key clearing on navigation
5. **Warning messaging**: Clear UI warnings about POC status

### Future Production Considerations

For production, consider:
- Browser extension architecture (keys never in page context)
- TEE-based proving service (keys never in browser)
- Hardware wallet integration for key derivation
- Session keys with on-chain spending limits

## Testing Checklist

- [ ] Same signature produces same keys (deterministic)
- [ ] Different accounts produce different keys
- [ ] Different chains produce different keys
- [ ] Keys are cleared on lock
- [ ] Keys are cleared on page unload
- [ ] Keys are cleared on disconnect
- [ ] Auto-lock works after timeout
- [ ] Operations fail gracefully when locked
- [ ] Error messages don't leak key material

## Dependencies

```json
{
  "dependencies": {
    "ethers": "^6.x",
    "@noble/hashes": "^1.x",
    "snarkjs": "^0.7.x"
  }
}
```

## File Structure

```
src/
├── lib/
│   ├── keyDerivation.ts     # Signature → keys derivation
│   ├── keyManager.ts        # Closure-based key storage
│   └── shieldedAddress.ts   # Address encoding/decoding
├── hooks/
│   └── useShieldedWallet.ts # React context and hooks
├── components/
│   ├── UnlockPrompt.tsx
│   ├── WalletStatus.tsx
│   └── ShieldForm.tsx
└── constants/
    └── derivation.ts        # Salt, domain, version constants
```
