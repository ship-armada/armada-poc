/**
 * Railgun Wallet - Key Management for ZK Proofs
 *
 * This module handles:
 * - Spending key derivation (EdDSA keypair)
 * - Nullifying key generation
 * - Note Public Key (NPK) computation
 * - EdDSA signature generation
 *
 * Key structure:
 * - spendingKey: Random 32 bytes (private)
 * - viewingKey: Derived from spendingKey (for decryption, not used in POC)
 * - nullifyingKey: Derived from spendingKey (for nullifier generation)
 * - publicKey: EdDSA public key derived from spendingKey
 * - MPK (Master Public Key): Poseidon(publicKey[0], publicKey[1], nullifyingKey)
 * - NPK (Note Public Key): Poseidon(MPK, random)
 */

import { ethers } from "ethers";
// @ts-ignore - circomlibjs doesn't have types
import { buildPoseidon, buildEddsa } from "circomlibjs";

// ============ Constants ============

export const SNARK_SCALAR_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

// ============ Types ============

export interface RailgunWallet {
  spendingKey: Uint8Array;
  nullifyingKey: bigint;
  publicKey: [bigint, bigint];  // EdDSA public key (Ax, Ay)
  mpk: bigint;  // Master Public Key
}

export interface Note {
  npk: bigint;
  token: bigint;
  value: bigint;
  random: bigint;
  // Position in merkle tree (set after shielding)
  treeNumber?: number;
  leafIndex?: number;
}

export interface SpentNote extends Note {
  treeNumber: number;
  leafIndex: number;
  // Merkle proof path
  pathElements: bigint[];
}

// ============ Globals ============

let poseidon: any = null;
let eddsa: any = null;
let F: any = null;  // Field operations

/**
 * Initialize cryptographic primitives
 */
export async function initCrypto(): Promise<void> {
  if (poseidon && eddsa) return;

  poseidon = await buildPoseidon();
  eddsa = await buildEddsa();
  F = poseidon.F;
}

// ============ Poseidon Hashing ============

/**
 * Poseidon hash of inputs, returns bigint
 */
export function poseidonHash(inputs: bigint[]): bigint {
  if (!poseidon) {
    throw new Error("Crypto not initialized. Call initCrypto() first.");
  }
  const hash = poseidon(inputs.map(x => F.e(x)));
  return BigInt(F.toString(hash));
}

/**
 * Poseidon hash returning bytes32 hex string
 */
export function poseidonHashHex(inputs: bigint[]): string {
  const hash = poseidonHash(inputs);
  return ethers.zeroPadValue(ethers.toBeHex(hash), 32);
}

// ============ Wallet Creation ============

/**
 * Create a new Railgun wallet from a spending key
 */
export async function createWallet(spendingKeyHex?: string): Promise<RailgunWallet> {
  await initCrypto();

  // Generate or use provided spending key
  let spendingKey: Uint8Array;
  if (spendingKeyHex) {
    spendingKey = ethers.getBytes(spendingKeyHex);
  } else {
    spendingKey = ethers.randomBytes(32);
  }

  // Derive nullifying key from spending key
  // In real Railgun, this uses more complex derivation
  // For POC, we use Poseidon(spendingKey)
  const spendingKeyBigInt = BigInt(ethers.hexlify(spendingKey));
  const nullifyingKey = poseidonHash([spendingKeyBigInt]) % SNARK_SCALAR_FIELD;

  // Derive EdDSA public key from spending key
  const publicKey = eddsa.prv2pub(spendingKey);
  const publicKeyBigInt: [bigint, bigint] = [
    BigInt(F.toString(publicKey[0])),
    BigInt(F.toString(publicKey[1]))
  ];

  // Compute Master Public Key: Poseidon(Ax, Ay, nullifyingKey)
  const mpk = poseidonHash([publicKeyBigInt[0], publicKeyBigInt[1], nullifyingKey]);

  return {
    spendingKey,
    nullifyingKey,
    publicKey: publicKeyBigInt,
    mpk
  };
}

/**
 * Create wallet from hex string
 */
export async function walletFromHex(spendingKeyHex: string): Promise<RailgunWallet> {
  return createWallet(spendingKeyHex);
}

// ============ Note Operations ============

/**
 * Generate a random value in the SNARK scalar field
 */
export function generateRandom(): bigint {
  const randomBytes = ethers.randomBytes(32);
  return BigInt(ethers.hexlify(randomBytes)) % SNARK_SCALAR_FIELD;
}

/**
 * Compute Note Public Key (NPK)
 * NPK = Poseidon(MPK, random)
 */
export function computeNpk(mpk: bigint, random: bigint): bigint {
  return poseidonHash([mpk, random]);
}

/**
 * Compute note commitment
 * commitment = Poseidon(npk, token, value)
 */
export function computeCommitment(npk: bigint, token: bigint, value: bigint): bigint {
  return poseidonHash([npk, token, value]);
}

/**
 * Compute nullifier for a note
 * nullifier = Poseidon(nullifyingKey, leafIndex)
 */
export function computeNullifier(nullifyingKey: bigint, leafIndex: bigint): bigint {
  return poseidonHash([nullifyingKey, leafIndex]);
}

/**
 * Create a note for a wallet
 */
export function createNote(
  wallet: RailgunWallet,
  tokenAddress: string,
  value: bigint,
  random?: bigint
): Note {
  random = random ?? generateRandom();

  // Compute NPK
  const npk = computeNpk(wallet.mpk, random);

  // Token ID for ERC20 is just the address as uint256
  const token = BigInt(tokenAddress);

  return {
    npk,
    token,
    value,
    random
  };
}

/**
 * Compute the commitment hash for a note
 */
export function getNoteCommitment(note: Note): bigint {
  return computeCommitment(note.npk, note.token, note.value);
}

// ============ EdDSA Signing ============

/**
 * Sign a message with EdDSA
 * Returns [R8x, R8y, S]
 */
export function signMessage(
  spendingKey: Uint8Array,
  message: bigint
): [bigint, bigint, bigint] {
  if (!eddsa) {
    throw new Error("Crypto not initialized. Call initCrypto() first.");
  }

  const signature = eddsa.signPoseidon(spendingKey, F.e(message));

  return [
    BigInt(F.toString(signature.R8[0])),
    BigInt(F.toString(signature.R8[1])),
    BigInt(signature.S.toString())
  ];
}

/**
 * Compute the message hash for a transaction
 * message = Poseidon(merkleRoot, boundParamsHash, nullifiers..., commitments...)
 */
export function computeTransactionMessage(
  merkleRoot: bigint,
  boundParamsHash: bigint,
  nullifiers: bigint[],
  commitments: bigint[]
): bigint {
  const inputs = [merkleRoot, boundParamsHash, ...nullifiers, ...commitments];
  return poseidonHash(inputs);
}

// ============ Token ID ============

/**
 * Get token ID from token data
 * For ERC20, tokenID is just the address
 */
export function getTokenId(tokenAddress: string): bigint {
  return BigInt(tokenAddress);
}

// ============ Utility Functions ============

/**
 * Convert bigint to bytes32 hex string
 */
export function toBytes32(value: bigint): string {
  return ethers.zeroPadValue(ethers.toBeHex(value), 32);
}

/**
 * Convert bytes32 hex string to bigint
 */
export function fromBytes32(hex: string): bigint {
  return BigInt(hex);
}

/**
 * Format wallet for display/storage
 */
export function exportWallet(wallet: RailgunWallet): {
  spendingKey: string;
  nullifyingKey: string;
  publicKey: [string, string];
  mpk: string;
} {
  return {
    spendingKey: ethers.hexlify(wallet.spendingKey),
    nullifyingKey: toBytes32(wallet.nullifyingKey),
    publicKey: [toBytes32(wallet.publicKey[0]), toBytes32(wallet.publicKey[1])],
    mpk: toBytes32(wallet.mpk)
  };
}
