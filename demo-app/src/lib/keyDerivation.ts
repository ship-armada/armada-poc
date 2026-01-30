/**
 * Key Derivation from MetaMask Signature
 *
 * Derives a deterministic BIP39 mnemonic from a MetaMask signature.
 * This allows users to access their shielded wallet by signing a message
 * with their EOA, without needing to store or remember a separate mnemonic.
 *
 * See: docs/WEB_KEY_DERIVATION.md
 */

import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { wordlist } from '@scure/bip39/wordlists/english.js';

// ============ Constants ============

const DOMAIN = 'railgun-poc';
const VERSION = 1;
const HKDF_SALT = 'railgun-poc-v1-key-derivation';

// ============ Message Construction ============

/**
 * Construct the deterministic message for signing
 *
 * @param account - Checksummed EOA address
 */
export function constructDerivationMessage(account: string): string {
  return `Railgun POC Key Derivation

Domain: ${DOMAIN}
Version: ${VERSION}
Account: ${account}

WARNING: Only sign this message on the official Railgun POC app.
Signing this message will derive your private shielded wallet keys.`;
}

// ============ Mnemonic Derivation ============

/**
 * Convert entropy bytes to BIP39 mnemonic
 *
 * Uses 128 bits (16 bytes) of entropy to generate a 12-word mnemonic.
 * Based on BIP39 specification.
 *
 * @param entropy - 16 bytes of entropy
 */
function entropyToMnemonic(entropy: Uint8Array): string {
  if (entropy.length !== 16) {
    throw new Error('Entropy must be 16 bytes for 12-word mnemonic');
  }

  // Calculate checksum (first 4 bits of SHA256)
  const hash = sha256(entropy);
  const checksumBits = hash[0] >> 4; // First 4 bits

  // Convert entropy to 11-bit words
  // 128 bits entropy + 4 bits checksum = 132 bits = 12 * 11 bits
  const bits: number[] = [];

  // Add entropy bits
  for (const byte of entropy) {
    for (let i = 7; i >= 0; i--) {
      bits.push((byte >> i) & 1);
    }
  }

  // Add checksum bits
  for (let i = 3; i >= 0; i--) {
    bits.push((checksumBits >> i) & 1);
  }

  // Convert to 11-bit words
  const words: string[] = [];
  for (let i = 0; i < 12; i++) {
    let wordIndex = 0;
    for (let j = 0; j < 11; j++) {
      wordIndex = (wordIndex << 1) | bits[i * 11 + j];
    }
    words.push(wordlist[wordIndex]);
  }

  return words.join(' ');
}

/**
 * Derive a deterministic 12-word mnemonic from a signature
 *
 * Uses HKDF to derive 128 bits of entropy from the signature,
 * then converts to a BIP39 mnemonic.
 *
 * @param signature - The 65-byte signature from personal_sign
 */
export function signatureToMnemonic(signature: string): string {
  // Convert signature to bytes
  const sigBytes = hexToBytes(signature);

  // Use HKDF to derive 16 bytes (128 bits) of entropy
  const saltBytes = new TextEncoder().encode(HKDF_SALT);
  const infoBytes = new TextEncoder().encode('mnemonic');

  const entropy = hkdf(sha256, sigBytes, saltBytes, infoBytes, 16);

  // Convert entropy to mnemonic
  return entropyToMnemonic(entropy);
}

/**
 * Derive an encryption key from the signature
 *
 * The encryption key is used by the SDK to encrypt wallet data.
 * Must be 64 hex characters (32 bytes).
 *
 * @param signature - The 65-byte signature from personal_sign
 */
export function signatureToEncryptionKey(signature: string): string {
  const sigBytes = hexToBytes(signature);

  // Use HKDF to derive 32 bytes
  const saltBytes = new TextEncoder().encode(HKDF_SALT);
  const infoBytes = new TextEncoder().encode('encryption-key');

  const keyBytes = hkdf(sha256, sigBytes, saltBytes, infoBytes, 32);

  return bytesToHex(keyBytes);
}

// ============ Utility Functions ============

/**
 * Convert hex string to Uint8Array
 */
function hexToBytes(hex: string): Uint8Array {
  const cleanHex = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(cleanHex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(cleanHex.substr(i * 2, 2), 16);
  }
  return bytes;
}

/**
 * Convert Uint8Array to hex string (without 0x prefix)
 */
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Validate that a mnemonic is valid BIP39
 *
 * Basic validation - checks word count and that all words are in wordlist
 */
export function validateMnemonic(mnemonic: string): boolean {
  const words = mnemonic.trim().split(/\s+/);

  // Must be 12 or 24 words
  if (words.length !== 12 && words.length !== 24) {
    return false;
  }

  // All words must be in the wordlist
  return words.every(word => wordlist.includes(word));
}
