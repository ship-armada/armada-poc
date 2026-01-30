/**
 * Shield Request Generator for Browser
 *
 * Creates ShieldRequest data compatible with ClientShieldProxyV2.
 * Uses poseidon-lite for Poseidon hashing (browser-compatible).
 *
 * This is a simplified POC implementation that:
 * - Uses address-based identity instead of full Railgun keys
 * - Mock encrypts ciphertext data (recoverable for testing)
 * - Produces valid Poseidon hashes for on-chain verification
 */

import { ethers } from 'ethers';
import { poseidon2 } from 'poseidon-lite';

// ============ Types ============

export interface ShieldRequestData {
  npk: string;           // bytes32 - Note Public Key (Poseidon hash)
  value: bigint;         // uint120 - Amount in token base units
  encryptedBundle: [string, string, string];  // bytes32[3]
  shieldKey: string;     // bytes32
}

// ============ Random Generation ============

// SNARK scalar field (BN254)
const SNARK_SCALAR_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/**
 * Generate a random value in the SNARK scalar field
 */
function generateRandom(): string {
  const randomBytes = ethers.randomBytes(32);
  const randomBigInt = BigInt(ethers.hexlify(randomBytes)) % SNARK_SCALAR_FIELD;
  return ethers.zeroPadValue(ethers.toBeHex(randomBigInt), 32);
}

// ============ NPK Generation ============

/**
 * Poseidon hash of two inputs, returns bytes32 hex string
 */
function poseidonHash2(a: bigint, b: bigint): string {
  const result = poseidon2([a, b]);
  return ethers.zeroPadValue(ethers.toBeHex(result), 32);
}

/**
 * Generate Note Public Key (npk)
 *
 * Real Railgun: npk = Poseidon(Poseidon(spendingPubKey, nullifyingKey), random)
 * POC Simplified: npk = Poseidon(recipientHash, random)
 *
 * @param railgunAddress - The 0zk... address (we use its hash as identity)
 * @param random - Random bytes32 value
 */
function generateNpk(railgunAddress: string, random: string): string {
  // Create a deterministic identity from the railgun address
  // Use keccak256 and mod by SNARK field to get a valid field element
  const addressHash = BigInt(ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(['string'], [railgunAddress])
  )) % SNARK_SCALAR_FIELD;

  const randomBigInt = BigInt(random) % SNARK_SCALAR_FIELD;
  return poseidonHash2(addressHash, randomBigInt);
}

// ============ Shield Ciphertext ============

/**
 * Generate mock ShieldCiphertext
 *
 * Real Railgun uses ECIES encryption with viewing keys.
 * For POC, we create properly formatted but recoverable data.
 *
 * @param railgunAddress - Recipient's 0zk... address
 * @param amount - Token amount
 * @param random - Random value used in NPK
 */
function generateShieldCiphertext(
  railgunAddress: string,
  amount: bigint,
  random: string
): { encryptedBundle: [string, string, string]; shieldKey: string } {
  // Bundle 0: Hash of railgun address (simulates IV + tag)
  const bundle0 = ethers.keccak256(ethers.toUtf8Bytes(railgunAddress));

  // Bundle 1: Encode amount (simulates encrypted amount)
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
 * Create a ShieldRequest for ClientShieldProxyV2
 *
 * @param railgunAddress - Recipient's 0zk... address
 * @param amount - Amount in token base units (e.g., USDC with 6 decimals)
 * @returns ShieldRequestData ready for contract call
 */
export async function createShieldRequest(
  railgunAddress: string,
  amount: bigint
): Promise<ShieldRequestData> {
  // Validate inputs
  if (!railgunAddress.startsWith('0zk')) {
    throw new Error('Invalid railgun address: must start with 0zk');
  }
  if (amount <= 0n) {
    throw new Error('Amount must be greater than 0');
  }

  // Generate random value
  const random = generateRandom();

  // Generate NPK
  const npk = generateNpk(railgunAddress, random);

  // Generate ciphertext
  const { encryptedBundle, shieldKey } = generateShieldCiphertext(
    railgunAddress,
    amount,
    random
  );

  return {
    npk,
    value: amount,
    encryptedBundle,
    shieldKey,
  };
}

/**
 * Initialize Poseidon (no-op for poseidon-lite, kept for API compatibility)
 */
export async function initPoseidon(): Promise<void> {
  // poseidon-lite is synchronous and doesn't need initialization
}

/**
 * Check if Poseidon is ready (always true for poseidon-lite)
 */
export function isPoseidonReady(): boolean {
  return true;
}
