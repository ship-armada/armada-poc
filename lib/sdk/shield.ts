/**
 * SDK Shield Operations
 *
 * Replaces manual shield_request.ts with SDK's proper:
 * - ShieldNote generation with Poseidon hashing
 * - ECIES encryption using viewing keys
 * - ShieldRequestStruct serialization
 * - Proper NPK (Note Public Key) derivation
 */

import {
  RailgunEngine,
  ShieldNoteERC20,
  ByteUtils,
  ShieldRequestStruct,
} from '@railgun-community/engine';
import { ethers } from 'ethers';

// ============ Types ============

export interface ShieldInput {
  railgunAddress: string;  // 0zk... format
  amount: bigint;          // Token amount in base units
  tokenAddress: string;    // Token contract address
}

export interface ShieldResult {
  shieldRequest: ShieldRequestStruct;
  random: string;          // Hex string - needed for note tracking
}

export interface ShieldBatchResult {
  shieldRequests: ShieldRequestStruct[];
  random: string;          // Shared random for batch
}

// ============ Constants ============

/**
 * Message to sign for deriving shield private key
 * User signs this with their wallet to derive the shieldPrivateKey
 */
export const SHIELD_SIGNATURE_MESSAGE = 'RAILGUN_SHIELD';

// ============ Shield Private Key ============

/**
 * Derive shield private key from wallet signature
 *
 * This is how Railgun derives the shield private key:
 * 1. User signs the message "RAILGUN_SHIELD" with their wallet
 * 2. The signature is hashed with keccak256 to get 32 bytes
 *
 * @param signature - Signature of SHIELD_SIGNATURE_MESSAGE
 * @returns 32-byte hex string (no 0x prefix) for use as shieldPrivateKey
 */
export function deriveShieldPrivateKey(signature: string): string {
  // Hash the signature to get deterministic 32 bytes
  const hash = ethers.keccak256(signature);
  // Remove 0x prefix for SDK compatibility
  return hash.slice(2);
}

/**
 * Generate a random shield private key (for testing/POC)
 *
 * In production, users should derive this from their wallet signature.
 * For POC/testing, we can use a random key.
 *
 * @returns 32-byte hex string (no 0x prefix)
 */
export function generateShieldPrivateKey(): string {
  return ByteUtils.randomHex(32);
}

// ============ Shield Request Generation ============

/**
 * Create a shield request for a single ERC20 token
 *
 * This uses the SDK's ShieldNoteERC20 class which:
 * - Derives NPK from masterPublicKey and random
 * - Creates proper TokenData structure
 * - Encrypts the random using ECIES with viewing keys
 *
 * @param input - Shield input parameters
 * @param shieldPrivateKey - 32-byte hex string (no 0x prefix)
 * @returns ShieldResult with request struct and random
 */
export async function createShieldRequest(
  input: ShieldInput,
  shieldPrivateKey: string
): Promise<ShieldResult> {
  // Decode Railgun address to get public keys
  const { masterPublicKey, viewingPublicKey } = RailgunEngine.decodeAddress(
    input.railgunAddress
  );

  // Generate random for note (16 bytes = 32 hex chars)
  const random = ByteUtils.randomHex(16);

  // Create shield note using SDK
  const shieldNote = new ShieldNoteERC20(
    masterPublicKey,
    random,
    input.amount,
    input.tokenAddress
  );

  // Serialize to ShieldRequestStruct
  // This encrypts the random using ECIES with the viewing keys
  const shieldRequest = await shieldNote.serialize(
    ByteUtils.hexToBytes(shieldPrivateKey),
    viewingPublicKey
  );

  return {
    shieldRequest,
    random,
  };
}

/**
 * Create multiple shield requests with a shared random
 *
 * Batching shields with the same random is more efficient
 * and is how the SDK typically operates.
 *
 * @param inputs - Array of shield inputs
 * @param shieldPrivateKey - 32-byte hex string (no 0x prefix)
 * @returns ShieldBatchResult with all requests and shared random
 */
export async function createShieldRequestBatch(
  inputs: ShieldInput[],
  shieldPrivateKey: string
): Promise<ShieldBatchResult> {
  if (inputs.length === 0) {
    throw new Error('At least one shield input required');
  }

  // Generate shared random for batch
  const random = ByteUtils.randomHex(16);
  const shieldPrivateKeyBytes = ByteUtils.hexToBytes(shieldPrivateKey);

  // Create all shield requests
  const shieldRequests = await Promise.all(
    inputs.map(async (input) => {
      const { masterPublicKey, viewingPublicKey } = RailgunEngine.decodeAddress(
        input.railgunAddress
      );

      const shieldNote = new ShieldNoteERC20(
        masterPublicKey,
        random,
        input.amount,
        input.tokenAddress
      );

      return shieldNote.serialize(shieldPrivateKeyBytes, viewingPublicKey);
    })
  );

  return {
    shieldRequests,
    random,
  };
}

// ============ Shield Request Encoding ============

/**
 * Encode shield request for CCTP transport
 *
 * This encodes the shield request in a format that can be
 * included in CCTP message payload and decoded by the hub.
 *
 * @param shieldRequest - Shield request struct from SDK
 * @returns ABI-encoded bytes
 */
export function encodeShieldRequest(shieldRequest: ShieldRequestStruct): string {
  // Encode the full shield request structure
  // This matches what HubCCTPReceiver expects to decode
  return ethers.AbiCoder.defaultAbiCoder().encode(
    [
      'tuple(tuple(bytes32 npk, tuple(uint8 tokenType, address tokenAddress, uint256 tokenSubID) token, uint120 value) preimage, tuple(bytes32[3] encryptedBundle, bytes32 shieldKey) ciphertext)',
    ],
    [shieldRequest]
  );
}

/**
 * Encode shield request in simplified format for POC
 *
 * This uses a simpler encoding that's easier to decode on-chain
 * for our POC contracts.
 *
 * @param shieldRequest - Shield request struct from SDK
 * @returns ABI-encoded bytes with simplified structure
 */
export function encodeShieldRequestSimple(
  shieldRequest: ShieldRequestStruct
): string {
  const { preimage, ciphertext } = shieldRequest;

  return ethers.AbiCoder.defaultAbiCoder().encode(
    ['bytes32', 'uint120', 'address', 'bytes32[3]', 'bytes32'],
    [
      preimage.npk,
      preimage.value,
      preimage.token.tokenAddress,
      ciphertext.encryptedBundle,
      ciphertext.shieldKey,
    ]
  );
}

/**
 * Decode simplified shield payload from CCTP
 *
 * @param encoded - ABI-encoded shield data
 * @returns Decoded shield components
 */
export function decodeShieldPayload(encoded: string): {
  npk: string;
  value: bigint;
  tokenAddress: string;
  encryptedBundle: [string, string, string];
  shieldKey: string;
} {
  const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
    ['bytes32', 'uint120', 'address', 'bytes32[3]', 'bytes32'],
    encoded
  );

  return {
    npk: decoded[0],
    value: decoded[1],
    tokenAddress: decoded[2],
    encryptedBundle: [decoded[3][0], decoded[3][1], decoded[3][2]],
    shieldKey: decoded[4],
  };
}

// ============ NPK Utilities ============

/**
 * Calculate NPK (Note Public Key) from master public key and random
 *
 * NPK = Poseidon(masterPublicKey, random)
 *
 * This is useful for verifying shield requests or
 * scanning for notes that belong to a wallet.
 *
 * @param masterPublicKey - Master public key from wallet
 * @param random - Random value used in shield (hex string)
 * @returns NPK as bigint
 */
export function calculateNpk(masterPublicKey: bigint, random: string): bigint {
  // Use the SDK's ShieldNote.getNotePublicKey which uses Poseidon
  // We need to import this method - for now reference the formula
  // NPK = Poseidon(masterPublicKey, random)

  // Import from engine - ShieldNote is abstract but has static method
  const { ShieldNote } = require('@railgun-community/engine');
  return ShieldNote.getNotePublicKey(masterPublicKey, random);
}

// ============ Validation ============

/**
 * Validate a Railgun address format
 *
 * @param address - Address to validate (should start with 0zk)
 * @returns true if valid
 */
export function isValidRailgunAddress(address: string): boolean {
  try {
    if (!address.startsWith('0zk')) {
      return false;
    }
    // Try to decode - will throw if invalid
    RailgunEngine.decodeAddress(address);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate shield private key format
 *
 * @param key - Key to validate (should be 64 hex chars, no 0x prefix)
 * @returns true if valid
 */
export function isValidShieldPrivateKey(key: string): boolean {
  // Should be 64 hex chars (32 bytes), no 0x prefix
  if (key.startsWith('0x')) {
    return false;
  }
  if (key.length !== 64) {
    return false;
  }
  return /^[0-9a-fA-F]+$/.test(key);
}

// ============ Utility Functions ============

/**
 * Format USDC amount for display (6 decimals)
 */
export function formatUSDC(amount: bigint): string {
  return ethers.formatUnits(amount, 6);
}

/**
 * Parse USDC amount from string (6 decimals)
 */
export function parseUSDC(amount: string): bigint {
  return ethers.parseUnits(amount, 6);
}

/**
 * Format shield request for logging
 */
export function formatShieldRequest(request: ShieldRequestStruct): string {
  return `
ShieldRequest:
  NPK: ${request.preimage.npk.toString().slice(0, 20)}...
  Value: ${request.preimage.value}
  Token: ${request.preimage.token.tokenAddress}
  ShieldKey: ${request.ciphertext.shieldKey.toString().slice(0, 20)}...
`;
}
