/**
 * Shield Request Generator - Creates proper Railgun ShieldRequest data
 *
 * This module generates ShieldRequest structs compatible with RailgunSmartWallet.shield()
 *
 * Key components:
 * - npk (Note Public Key): Poseidon hash representing note ownership
 * - ShieldCiphertext: Encrypted data for wallet recovery
 *
 * For POC, we use simplified cryptography:
 * - npk: Poseidon(random) instead of Poseidon(Poseidon(spendingKey, nullifyingKey), random)
 * - encryptedBundle: Mock encryption (plaintext for testing)
 * - shieldKey: Random public key placeholder
 */

import { ethers } from "ethers";
// @ts-ignore - circomlibjs doesn't have types
import { buildPoseidon } from "circomlibjs";

// ============ Types ============

export interface ShieldRequestData {
  // For CommitmentPreimage
  npk: string;           // bytes32 - Poseidon hash
  value: bigint;         // uint120 - Amount in token units
  tokenAddress: string;  // Token contract address

  // For ShieldCiphertext
  encryptedBundle: [string, string, string];  // bytes32[3]
  shieldKey: string;     // bytes32

  // For encoding
  encoded: string;       // ABI-encoded payload for CCTP
}

export interface ShieldNote {
  request: ShieldRequestData;
  // Secret data needed for spending
  random: string;        // bytes32 - Random value used in npk
  preimage: {
    recipient: string;
    amount: bigint;
  };
}

// ============ Poseidon Setup ============

let poseidon: any = null;
let poseidonF: any = null;

/**
 * Initialize Poseidon hash function
 */
export async function initPoseidon(): Promise<void> {
  if (poseidon) return;
  poseidon = await buildPoseidon();
  poseidonF = (inputs: bigint[]) => {
    const hash = poseidon(inputs);
    return poseidon.F.toString(hash);
  };
}

/**
 * Poseidon hash of inputs, returns bytes32 hex string
 */
export function poseidonHash(inputs: bigint[]): string {
  if (!poseidon) {
    throw new Error("Poseidon not initialized. Call initPoseidon() first.");
  }
  const result = poseidonF(inputs);
  return ethers.zeroPadValue(ethers.toBeHex(BigInt(result)), 32);
}

// ============ NPK Generation ============

/**
 * Generate a random value in the SNARK scalar field
 */
export function generateRandom(): string {
  // SNARK_SCALAR_FIELD from Railgun
  const SNARK_SCALAR_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

  // Generate random bytes and mod by field
  const randomBytes = ethers.randomBytes(32);
  const randomBigInt = BigInt(ethers.hexlify(randomBytes)) % SNARK_SCALAR_FIELD;

  return ethers.zeroPadValue(ethers.toBeHex(randomBigInt), 32);
}

/**
 * Generate Note Public Key (npk)
 *
 * Real Railgun: npk = Poseidon(Poseidon(spendingPubKey, nullifyingKey), random)
 * POC Simplified: npk = Poseidon(recipientHash, random)
 *
 * The simplified version still produces valid Poseidon hashes that work with
 * the on-chain verification, but doesn't require full key derivation.
 */
export function generateNpk(recipientAddress: string, random: string): string {
  // Create a deterministic "identity" from recipient address
  // This simulates the Poseidon(spendingPubKey, nullifyingKey) part
  const recipientHash = BigInt(ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["address"], [recipientAddress])
  ));

  // Hash with random to get npk
  const randomBigInt = BigInt(random);

  return poseidonHash([recipientHash, randomBigInt]);
}

// ============ Shield Ciphertext ============

/**
 * Generate mock ShieldCiphertext
 *
 * Real Railgun uses ECIES encryption with recipient's viewing key.
 * For POC, we create properly formatted but unencrypted data.
 *
 * encryptedBundle[0]: IV (16 bytes) + tag (16 bytes)
 * encryptedBundle[1]: random (16 bytes) + sender IV (16 bytes)
 * encryptedBundle[2]: receiver viewing public key (32 bytes)
 */
export function generateShieldCiphertext(
  recipientAddress: string,
  amount: bigint,
  random: string
): { encryptedBundle: [string, string, string]; shieldKey: string } {
  // For POC, we encode the data in a way that's recoverable
  // but not actually encrypted

  // Bundle 0: Encode recipient address (simulates IV + tag)
  const bundle0 = ethers.zeroPadValue(recipientAddress, 32);

  // Bundle 1: Encode amount (simulates random + sender IV)
  const bundle1 = ethers.zeroPadValue(ethers.toBeHex(amount), 32);

  // Bundle 2: Store random for note recovery
  const bundle2 = random;

  // Shield key: Random public key placeholder
  const shieldKey = ethers.hexlify(ethers.randomBytes(32));

  return {
    encryptedBundle: [bundle0, bundle1, bundle2],
    shieldKey,
  };
}

// ============ Main API ============

/**
 * Create a complete ShieldRequest for RailgunSmartWallet
 *
 * @param recipientAddress - Ethereum address of recipient (for POC identity)
 * @param amount - Amount in token units (e.g., USDC with 6 decimals)
 * @param tokenAddress - Token contract address
 * @returns ShieldNote with all data needed for shielding and later spending
 */
export async function createShieldRequest(
  recipientAddress: string,
  amount: bigint,
  tokenAddress: string
): Promise<ShieldNote> {
  // Ensure Poseidon is initialized
  await initPoseidon();

  // Generate random value
  const random = generateRandom();

  // Generate NPK
  const npk = generateNpk(recipientAddress, random);

  // Generate ciphertext
  const { encryptedBundle, shieldKey } = generateShieldCiphertext(
    recipientAddress,
    amount,
    random
  );

  // Encode for CCTP transport
  // This matches what HubCCTPReceiverV2 expects to decode
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    ["bytes32", "uint120", "bytes32[3]", "bytes32"],
    [npk, amount, encryptedBundle, shieldKey]
  );

  const request: ShieldRequestData = {
    npk,
    value: amount,
    tokenAddress,
    encryptedBundle: encryptedBundle as [string, string, string],
    shieldKey,
    encoded,
  };

  return {
    request,
    random,
    preimage: {
      recipient: recipientAddress,
      amount,
    },
  };
}

/**
 * Decode a shield request from CCTP payload
 */
export function decodeShieldPayload(encoded: string): {
  npk: string;
  value: bigint;
  encryptedBundle: [string, string, string];
  shieldKey: string;
} {
  const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
    ["bytes32", "uint120", "bytes32[3]", "bytes32"],
    encoded
  );

  return {
    npk: decoded[0],
    value: decoded[1],
    encryptedBundle: [decoded[2][0], decoded[2][1], decoded[2][2]],
    shieldKey: decoded[3],
  };
}

/**
 * Recover note data from ShieldCiphertext (POC only)
 * Real Railgun would use ECIES decryption with viewing key
 */
export function recoverNoteFromCiphertext(
  encryptedBundle: [string, string, string]
): {
  recipient: string;
  amount: bigint;
  random: string;
} {
  // Decode from our POC format
  const recipient = ethers.getAddress(
    ethers.dataSlice(encryptedBundle[0], 12) // Last 20 bytes of 32-byte padded address
  );
  const amount = BigInt(encryptedBundle[1]);
  const random = encryptedBundle[2];

  return { recipient, amount, random };
}

// ============ Utility Functions ============

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
