/**
 * Shield Operations using Railgun SDK Components
 *
 * Creates proper ShieldRequest structs using the SDK's cryptography:
 * - Poseidon hashing for NPK
 * - ECIES encryption for ciphertext
 */

import {
  RailgunEngine,
  ShieldNoteERC20,
  ByteUtils,
  type ShieldRequestStruct,
} from '@railgun-community/engine'
import { ethers } from 'ethers'

// ============ Types ============

export interface ShieldRequestData {
  npk: string // bytes32 - Note Public Key (Poseidon hash)
  value: bigint // Amount in token base units
  encryptedBundle: [string, string, string] // bytes32[3]
  shieldKey: string // bytes32
}

// ============ Shield Private Key ============

/**
 * Message to sign for deriving shield private key
 * This is the standard Railgun message
 */
export const SHIELD_SIGNATURE_MESSAGE = 'RAILGUN_SHIELD'

/**
 * Derive shield private key from wallet signature
 *
 * The user signs SHIELD_SIGNATURE_MESSAGE with their wallet.
 * The signature is hashed to get a deterministic 32-byte key.
 *
 * @param signature - Signature of SHIELD_SIGNATURE_MESSAGE
 * @returns 32-byte hex string (no 0x prefix) for use as shieldPrivateKey
 */
export function deriveShieldPrivateKey(signature: string): string {
  const hash = ethers.keccak256(signature)
  // Remove 0x prefix for SDK compatibility
  return hash.slice(2)
}

// ============ Shield Request Generation ============

/**
 * Create a ShieldRequest using the Railgun SDK
 *
 * This uses the SDK's proper cryptography:
 * - ShieldNoteERC20 for note creation
 * - Poseidon hashing for NPK
 * - ECIES encryption for ciphertext
 *
 * @param railgunAddress - Recipient's 0zk... address
 * @param amount - Amount in token base units
 * @param tokenAddress - Token contract address
 * @param shieldPrivateKey - 32-byte hex string (no 0x prefix)
 * @returns ShieldRequestData ready for contract call
 */
export async function createShieldRequest(
  railgunAddress: string,
  amount: bigint,
  tokenAddress: string,
  shieldPrivateKey: string,
): Promise<ShieldRequestData> {
  // Validate railgun address
  if (!railgunAddress.startsWith('0zk')) {
    throw new Error('Invalid railgun address: must start with 0zk')
  }

  // Decode Railgun address to get public keys
  const { masterPublicKey, viewingPublicKey } =
    RailgunEngine.decodeAddress(railgunAddress)

  // Generate random for note (16 bytes)
  const random = ByteUtils.randomHex(16)

  // Create shield note using SDK
  const shieldNote = new ShieldNoteERC20(
    masterPublicKey,
    random,
    amount,
    tokenAddress,
  )

  // Serialize to ShieldRequestStruct
  // This encrypts the random using ECIES with the viewing keys
  const shieldRequest: ShieldRequestStruct = await shieldNote.serialize(
    ByteUtils.hexToBytes(shieldPrivateKey),
    viewingPublicKey,
  )

  // Extract values for contract call
  return {
    npk: shieldRequest.preimage.npk.toString(),
    value: BigInt(shieldRequest.preimage.value.toString()),
    encryptedBundle: [
      shieldRequest.ciphertext.encryptedBundle[0].toString(),
      shieldRequest.ciphertext.encryptedBundle[1].toString(),
      shieldRequest.ciphertext.encryptedBundle[2].toString(),
    ],
    shieldKey: shieldRequest.ciphertext.shieldKey.toString(),
  }
}

/**
 * Format NPK for contract call (ensure proper bytes32 format)
 */
export function formatNpkForContract(npk: string): string {
  // If it's a bigint string, convert to hex
  if (!npk.startsWith('0x')) {
    return ethers.zeroPadValue(ethers.toBeHex(BigInt(npk)), 32)
  }
  return ethers.zeroPadValue(npk, 32)
}

/**
 * Format bytes32 value for contract call
 */
export function formatBytes32ForContract(value: string): string {
  if (!value.startsWith('0x')) {
    // Assume it's a bigint string
    return ethers.zeroPadValue(ethers.toBeHex(BigInt(value)), 32)
  }
  return ethers.zeroPadValue(value, 32)
}
