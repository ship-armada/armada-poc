import { ethers } from "ethers";

/**
 * Note Generator - Mock commitment and note generation for POC
 *
 * In real Railgun:
 * - Commitments use Poseidon hash over (pubkey, token, amount, randomness)
 * - Encrypted notes use asymmetric encryption with recipient's viewing key
 *
 * For POC, we use simplified versions that produce correctly-formatted data.
 */

// ============ Types ============

export interface ShieldNote {
  commitment: string; // bytes32 hex
  encryptedNote: string; // bytes hex
  randomness: string; // bytes32 hex (secret, needed for spending)
}

export interface ShieldPayload {
  commitment: string;
  encryptedNote: string;
  encoded: string; // ABI-encoded payload for CCTP transport
}

// ============ Commitment Generation ============

/**
 * Generate a mock commitment for shielding
 *
 * Real Railgun: Poseidon(pubkey, token, amount, randomness)
 * POC: keccak256(recipient, amount, randomness)
 */
export function generateCommitment(
  recipientAddress: string,
  amount: bigint
): ShieldNote {
  // Generate random blinding factor
  const randomness = ethers.hexlify(ethers.randomBytes(32));

  // Create commitment hash
  const commitment = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "uint256", "bytes32"],
      [recipientAddress, amount, randomness]
    )
  );

  // Create mock encrypted note
  // Real Railgun: Encrypts (token, amount, randomness) with recipient's viewing key
  // POC: Just encode the data (not actually encrypted)
  const encryptedNote = ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "uint256", "bytes32"],
    [recipientAddress, amount, randomness]
  );

  return {
    commitment,
    encryptedNote,
    randomness,
  };
}

/**
 * Generate a deterministic commitment (for testing)
 * Uses a seed instead of random bytes for reproducibility
 */
export function generateDeterministicCommitment(
  recipientAddress: string,
  amount: bigint,
  seed: string
): ShieldNote {
  // Derive randomness from seed
  const randomness = ethers.keccak256(
    ethers.toUtf8Bytes(`railgun-poc-${seed}`)
  );

  const commitment = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "uint256", "bytes32"],
      [recipientAddress, amount, randomness]
    )
  );

  const encryptedNote = ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "uint256", "bytes32"],
    [recipientAddress, amount, randomness]
  );

  return {
    commitment,
    encryptedNote,
    randomness,
  };
}

// ============ Payload Encoding ============

/**
 * Encode shield payload for CCTP transport
 *
 * This is what gets passed through MockUSDC burn → receiveMessage → HubCCTPReceiver
 */
export function encodeShieldPayload(
  commitment: string,
  encryptedNote: string
): ShieldPayload {
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    ["bytes32", "bytes"],
    [commitment, encryptedNote]
  );

  return {
    commitment,
    encryptedNote,
    encoded,
  };
}

/**
 * Decode shield payload (for verification/debugging)
 */
export function decodeShieldPayload(encoded: string): {
  commitment: string;
  encryptedNote: string;
} {
  const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
    ["bytes32", "bytes"],
    encoded
  );

  return {
    commitment: decoded[0],
    encryptedNote: decoded[1],
  };
}

// ============ Note Decryption (Mock) ============

/**
 * Decode an encrypted note (mock decryption)
 *
 * Real Railgun: Uses recipient's viewing key to decrypt
 * POC: Just ABI decode (notes aren't actually encrypted)
 */
export function decodeEncryptedNote(encryptedNote: string): {
  recipient: string;
  amount: bigint;
  randomness: string;
} {
  const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
    ["address", "uint256", "bytes32"],
    encryptedNote
  );

  return {
    recipient: decoded[0],
    amount: decoded[1],
    randomness: decoded[2],
  };
}

/**
 * Verify a commitment matches the note data
 */
export function verifyCommitment(
  commitment: string,
  recipient: string,
  amount: bigint,
  randomness: string
): boolean {
  const expectedCommitment = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "uint256", "bytes32"],
      [recipient, amount, randomness]
    )
  );

  return commitment.toLowerCase() === expectedCommitment.toLowerCase();
}

// ============ Nullifier Generation ============

/**
 * Generate nullifier for spending a note
 *
 * Real Railgun: Poseidon(commitment, spendingKey, leafIndex)
 * POC: keccak256(commitment, randomness)
 */
export function generateNullifier(
  commitment: string,
  randomness: string
): string {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "bytes32"],
      [commitment, randomness]
    )
  );
}

// ============ Utility Functions ============

/**
 * Generate a complete shield request
 * Returns everything needed to call ClientShieldProxy.shield()
 */
export function createShieldRequest(
  recipientAddress: string,
  amount: bigint
): {
  note: ShieldNote;
  payload: ShieldPayload;
  nullifier: string;
} {
  const note = generateCommitment(recipientAddress, amount);
  const payload = encodeShieldPayload(note.commitment, note.encryptedNote);
  const nullifier = generateNullifier(note.commitment, note.randomness);

  return { note, payload, nullifier };
}

/**
 * Format amount for display (USDC has 6 decimals)
 */
export function formatUSDC(amount: bigint): string {
  return ethers.formatUnits(amount, 6);
}

/**
 * Parse USDC amount from string
 */
export function parseUSDC(amount: string): bigint {
  return ethers.parseUnits(amount, 6);
}
