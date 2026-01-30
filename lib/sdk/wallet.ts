/**
 * SDK Wallet Management
 *
 * Replaces manual key derivation (lib/wallet.ts) with SDK's proper:
 * - BIP39 mnemonic generation
 * - BIP32 key derivation (spending + viewing keys)
 * - Railgun address generation (0zk... format)
 * - EdDSA signing
 */

import {
  RailgunEngine,
  RailgunWallet,
  Mnemonic,
  ByteUtils,
} from '@railgun-community/engine';
import { getEngine } from './init';
import * as fs from 'fs';
import * as path from 'path';

// ============ Types ============

export interface WalletInfo {
  id: string;
  mnemonic: string;
  railgunAddress: string;
  derivationIndex: number;
  createdAt: string;
}

export interface WalletKeys {
  masterPublicKey: bigint;
  viewingPublicKey: Uint8Array;
  nullifyingKey: bigint;
}

// ============ Constants ============

const WALLETS_DIR = path.join(__dirname, '../../wallets');

// Default encryption key for POC (in production, derive from user password)
// Must be 64 hex chars (32 bytes)
export const DEFAULT_ENCRYPTION_KEY = '0101010101010101010101010101010101010101010101010101010101010101';

// ============ Wallet Creation ============

/**
 * Generate a new BIP39 mnemonic
 *
 * @param strength - Mnemonic strength (128 = 12 words, 256 = 24 words)
 */
export function generateMnemonic(strength: 128 | 256 = 128): string {
  return Mnemonic.generate(strength);
}

/**
 * Validate a BIP39 mnemonic
 */
export function validateMnemonic(mnemonic: string): boolean {
  return Mnemonic.validate(mnemonic);
}

/**
 * Create a new wallet from mnemonic
 *
 * @param encryptionKey - Key for encrypting wallet data (64 hex chars)
 * @param mnemonic - Optional mnemonic (generates new if not provided)
 * @param derivationIndex - BIP32 derivation index (default: 0)
 */
export async function createWallet(
  encryptionKey: string = DEFAULT_ENCRYPTION_KEY,
  mnemonic?: string,
  derivationIndex: number = 0
): Promise<WalletInfo> {
  const engine = getEngine();

  // Generate new mnemonic if not provided
  const walletMnemonic = mnemonic ?? generateMnemonic();

  // Validate mnemonic
  if (!validateMnemonic(walletMnemonic)) {
    throw new Error('Invalid mnemonic');
  }

  // Create wallet in engine
  const wallet = await engine.createWalletFromMnemonic(
    encryptionKey,
    walletMnemonic,
    derivationIndex,
    undefined // creationBlockNumbers (not needed for local devnet)
  );

  // Get Railgun address (0zk...)
  const railgunAddress = wallet.getAddress();

  const info: WalletInfo = {
    id: wallet.id,
    mnemonic: walletMnemonic,
    railgunAddress,
    derivationIndex,
    createdAt: new Date().toISOString(),
  };

  return info;
}

/**
 * Load an existing wallet by ID
 *
 * @param walletId - Wallet ID
 * @param encryptionKey - Key for decrypting wallet data
 */
export async function loadWallet(
  walletId: string,
  encryptionKey: string = DEFAULT_ENCRYPTION_KEY
): Promise<RailgunWallet> {
  const engine = getEngine();
  return (await engine.loadExistingWallet(walletId, encryptionKey)) as RailgunWallet;
}

/**
 * Get wallet keys for cryptographic operations
 *
 * @param wallet - RailgunWallet instance
 */
export function getWalletKeys(wallet: RailgunWallet): WalletKeys {
  return {
    masterPublicKey: wallet.masterPublicKey,
    viewingPublicKey: wallet.viewingKeyPair.pubkey,
    nullifyingKey: wallet.nullifyingKey,
  };
}

/**
 * Get Railgun address from wallet
 *
 * @param wallet - RailgunWallet instance
 */
export function getAddress(wallet: RailgunWallet): string {
  return wallet.getAddress();
}

/**
 * Decode a Railgun address to get public keys
 *
 * @param railgunAddress - 0zk... address
 */
export function decodeAddress(railgunAddress: string): {
  masterPublicKey: bigint;
  viewingPublicKey: Uint8Array;
} {
  const decoded = RailgunEngine.decodeAddress(railgunAddress);
  return {
    masterPublicKey: decoded.masterPublicKey,
    viewingPublicKey: decoded.viewingPublicKey,
  };
}

// ============ Wallet Storage ============

/**
 * Save wallet info to file
 *
 * @param info - Wallet info to save
 * @param filename - Filename (without extension)
 */
export function saveWallet(info: WalletInfo, filename: string): void {
  // Ensure wallets directory exists
  if (!fs.existsSync(WALLETS_DIR)) {
    fs.mkdirSync(WALLETS_DIR, { recursive: true });
  }

  const filepath = path.join(WALLETS_DIR, `${filename}.json`);
  fs.writeFileSync(filepath, JSON.stringify(info, null, 2));
  console.log(`Wallet saved to ${filepath}`);
}

/**
 * Load wallet info from file
 *
 * @param filename - Filename (without extension)
 */
export function loadWalletInfo(filename: string): WalletInfo {
  const filepath = path.join(WALLETS_DIR, `${filename}.json`);

  if (!fs.existsSync(filepath)) {
    throw new Error(`Wallet file not found: ${filepath}`);
  }

  return JSON.parse(fs.readFileSync(filepath, 'utf-8'));
}

/**
 * Check if wallet file exists
 *
 * @param filename - Filename (without extension)
 */
export function walletExists(filename: string): boolean {
  const filepath = path.join(WALLETS_DIR, `${filename}.json`);
  return fs.existsSync(filepath);
}

/**
 * List all saved wallets
 */
export function listWallets(): string[] {
  if (!fs.existsSync(WALLETS_DIR)) {
    return [];
  }

  return fs
    .readdirSync(WALLETS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace('.json', ''));
}

// ============ Wallet Recovery ============

/**
 * Create or load a wallet by name
 * If wallet file exists, loads it. Otherwise creates new.
 *
 * @param name - Wallet name (used as filename)
 * @param encryptionKey - Encryption key
 * @param mnemonic - Optional mnemonic for new wallet
 */
export async function getOrCreateWallet(
  name: string,
  encryptionKey: string = DEFAULT_ENCRYPTION_KEY,
  mnemonic?: string
): Promise<{ wallet: RailgunWallet; info: WalletInfo; isNew: boolean }> {
  const engine = getEngine();

  if (walletExists(name)) {
    // Load existing wallet
    const info = loadWalletInfo(name);
    console.log(`Loading existing wallet: ${name}`);

    // Try to load from engine first (may already be loaded)
    try {
      const wallet = (await engine.loadExistingWallet(
        info.id,
        encryptionKey
      )) as RailgunWallet;
      return { wallet, info, isNew: false };
    } catch {
      // Wallet not in engine, recreate from mnemonic
      console.log(`Recreating wallet from mnemonic...`);
      const wallet = (await engine.createWalletFromMnemonic(
        encryptionKey,
        info.mnemonic,
        info.derivationIndex,
        undefined
      )) as RailgunWallet;
      return { wallet, info, isNew: false };
    }
  } else {
    // Create new wallet
    console.log(`Creating new wallet: ${name}`);

    // Generate mnemonic if not provided
    const walletMnemonic = mnemonic ?? generateMnemonic();

    // Validate mnemonic
    if (!validateMnemonic(walletMnemonic)) {
      throw new Error('Invalid mnemonic');
    }

    // Create wallet in engine (wallet is already loaded after creation)
    const wallet = (await engine.createWalletFromMnemonic(
      encryptionKey,
      walletMnemonic,
      0, // derivationIndex
      undefined // creationBlockNumbers
    )) as RailgunWallet;

    const info: WalletInfo = {
      id: wallet.id,
      mnemonic: walletMnemonic,
      railgunAddress: wallet.getAddress(),
      derivationIndex: 0,
      createdAt: new Date().toISOString(),
    };

    saveWallet(info, name);
    return { wallet, info, isNew: true };
  }
}

// ============ Utility Functions ============

/**
 * Generate a random hex string
 *
 * @param bytes - Number of bytes
 */
export function randomHex(bytes: number): string {
  return ByteUtils.randomHex(bytes);
}

/**
 * Format wallet info for display
 */
export function formatWalletInfo(info: WalletInfo): string {
  return `
Wallet: ${info.id.slice(0, 16)}...
Address: ${info.railgunAddress.slice(0, 40)}...
Derivation Index: ${info.derivationIndex}
Created: ${info.createdAt}
`;
}
