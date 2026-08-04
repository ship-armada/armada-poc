// ABOUTME: Phase 0 Spike 1 — seed→wallet reproducibility. Derives a full Railgun keyset from a fixed
// ABOUTME: rootSecret via the interface's Phase-1 mnemonic-shim path and proves it reproduces byte-for-byte.
//
// Throwaway spike code (armada-sdk Phase 0, ARMADA_SDK.md §10 / handoff Step 3). The PERMANENT
// artifact is the emitted keyset-vectors.json; this script is not part of the standing test suite.
//
// What it pins (open decision 6): whether `rootSecret -> deriveInternalMnemonic -> createWalletFromMnemonic`
// yields a stable canonical keyset (spending priv/pub, viewing priv/pub, nullifying key,
// masterPublicKey, 0zk address). Runs OFFLINE — key derivation needs no chain/provider (lib/sdk/init.ts).
//
// Run:  npx ts-node scripts/capture/spike-seed-to-wallet.ts

import * as fs from 'fs';
import * as path from 'path';

import { entropyToMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';

import {
  RailgunEngine,
  RailgunWallet,
  POI,
  POINodeInterface,
} from '@railgun-community/engine';

import { initializeEngine, shutdownEngine, clearDatabase, getEngine } from '../../lib/sdk/init';

// ── POI stub ───────────────────────────────────────────────
// The engine requires POI initialized even when unused (PPOI is stripped entirely in the SDK
// fork — see ARMADA_SDK.md §3.5 — but the stock engine we capture against still expects it).
class StubPOINodeInterface extends POINodeInterface {
  isActive(): boolean { return false; }
  async isRequired(): Promise<boolean> { return false; }
  async getPOIsPerList(): Promise<Record<string, any>> { return {}; }
  async getPOIMerkleProofs(): Promise<any[]> { return []; }
  async validatePOIMerkleroots(): Promise<boolean> { return true; }
  async submitPOI(): Promise<void> { /* no-op */ }
  async submitLegacyTransactProofs(): Promise<void> { /* no-op */ }
}
POI.init([], new StubPOINodeInterface());

// ── Provenance stamp ───────────────────────────────────────
// Final: captured on main after #410/#417 merged (the pinned-base capture was byte-identical).
const STAMP = {
  engineVersion: '9.6.0',
  capturedFromMainSha: 'b21d4d9b2fe0e06fa44589de164ba00c54bb2b43',
  provisional: false,
};

const VECTORS_DIR = path.join(__dirname, 'vectors');
const OUT_FILE = path.join(VECTORS_DIR, 'keyset-vectors.json');

// The SDK encryption key only encrypts at-rest storage — it does NOT influence the derived
// identity keyset or 0zk address. Fixed here so the spike is deterministic.
const ENC_KEY = '0101010101010101010101010101010101010101010101010101010101010101';

// ── Fixed rootSecret test seeds (known inputs → known keysets) ──
const SEEDS: ReadonlyArray<{ name: string; hex: string }> = [
  { name: 'all-ones', hex: '01'.repeat(32) },
  { name: 'counting-1..32', hex: Array.from({ length: 32 }, (_, i) => (i + 1).toString(16).padStart(2, '0')).join('') },
  { name: 'fixed-pseudorandom', hex: 'a3f291c8b7e0d4569a1f2e3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a6978' },
];

// ── Serialization helpers ──────────────────────────────────
function bigintToHex(n: bigint): string {
  return '0x' + n.toString(16).padStart(64, '0');
}
function bytesToHex(b: Uint8Array): string {
  return '0x' + Buffer.from(b).toString('hex');
}
function hexToBytes(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

interface Keyset {
  masterPublicKey: string;
  nullifyingKey: string;
  spendingPublicKey: [string, string];
  spendingPrivateKey: string;
  viewingPublicKey: string;
  viewingPrivateKey: string;
  railgunAddress: string;
  walletId: string;
}

// Mirrors apps/armada-interface/src/lib/crypto/kdf.ts::deriveInternalMnemonic — the Phase-1
// mnemonic shim (24-word BIP-39 from the 32-byte rootSecret). Replicated (one deterministic
// standard call) rather than cross-imported from the ESM interface workspace into this CJS script.
function deriveInternalMnemonic(rootSecret: Uint8Array): string {
  return entropyToMnemonic(rootSecret, wordlist);
}

async function deriveKeyset(rootSecretHex: string): Promise<{ keyset: Keyset; mnemonic: string }> {
  const rootSecret = hexToBytes(rootSecretHex);
  const mnemonic = deriveInternalMnemonic(rootSecret);

  clearDatabase();
  const engine = await initializeEngine('spike');
  try {
    const railgunWalletInfo = await engine.createWalletFromMnemonic(ENC_KEY, mnemonic, 0, undefined);
    const wallet = engine.wallets[railgunWalletInfo.id] as RailgunWallet;

    const spendingKeyPair = await wallet.getSpendingKeyPair(ENC_KEY);
    const viewingKeyPair = wallet.getViewingKeyPair();

    // Sanity: the encoded 0zk address must decode back to this wallet's public keys.
    const decoded = RailgunEngine.decodeAddress(wallet.getAddress());
    if (decoded.masterPublicKey !== wallet.masterPublicKey) {
      throw new Error('0zk address masterPublicKey mismatch on decode round-trip');
    }
    if (bytesToHex(decoded.viewingPublicKey) !== bytesToHex(viewingKeyPair.pubkey)) {
      throw new Error('0zk address viewingPublicKey mismatch on decode round-trip');
    }

    const keyset: Keyset = {
      masterPublicKey: bigintToHex(wallet.masterPublicKey),
      nullifyingKey: bigintToHex(wallet.nullifyingKey),
      spendingPublicKey: [bigintToHex(spendingKeyPair.pubkey[0]), bigintToHex(spendingKeyPair.pubkey[1])],
      spendingPrivateKey: bytesToHex(spendingKeyPair.privateKey),
      viewingPublicKey: bytesToHex(viewingKeyPair.pubkey),
      viewingPrivateKey: bytesToHex(viewingKeyPair.privateKey),
      railgunAddress: wallet.getAddress(),
      walletId: railgunWalletInfo.id,
    };
    return { keyset, mnemonic };
  } finally {
    await shutdownEngine();
  }
}

function assertEqual(name: string, a: Keyset, b: Keyset): void {
  const ja = JSON.stringify(a);
  const jb = JSON.stringify(b);
  if (ja !== jb) {
    throw new Error(`REPRODUCIBILITY FAILURE for ${name}:\n  pass1=${ja}\n  pass2=${jb}`);
  }
}

async function main() {
  console.log('='.repeat(64));
  console.log('  Phase 0 Spike 1 — seed → wallet reproducibility');
  console.log(`  engine ${STAMP.engineVersion} · main ${STAMP.capturedFromMainSha.slice(0, 10)}`);
  console.log('='.repeat(64));

  const captured: any[] = [];

  for (const seed of SEEDS) {
    console.log(`\n── ${seed.name} ──`);
    // Two fully independent passes (fresh engine + cleared DB each time) prove the keyset is a
    // pure function of the seed, not cached state.
    const pass1 = await deriveKeyset(seed.hex);
    const pass2 = await deriveKeyset(seed.hex);
    assertEqual(seed.name, pass1.keyset, pass2.keyset);
    console.log(`  0zk address : ${pass1.keyset.railgunAddress}`);
    console.log(`  masterPubKey: ${pass1.keyset.masterPublicKey}`);
    console.log(`  reproducible: ✓ (2 independent passes byte-identical)`);

    captured.push({
      name: seed.name,
      rootSecret: '0x' + seed.hex,
      // Included because these are test vectors from KNOWN test seeds — not real user secrets.
      internalMnemonic: pass1.mnemonic,
      encryptionKey: '0x' + ENC_KEY,
      keyset: pass1.keyset,
      derivation: {
        path: 'rootSecret -> deriveInternalMnemonic (BIP-39 entropyToMnemonic) -> createWalletFromMnemonic(index=0)',
        note: 'Phase-1 mnemonic-shim path (apps/armada-interface/src/lib/crypto/kdf.ts). encryptionKey does NOT affect identity.',
      },
    });
  }

  fs.mkdirSync(VECTORS_DIR, { recursive: true });
  const out = {
    vectorType: 'keyset',
    primitive: 'key-derivation (ARMADA_SDK.md §2)',
    ...STAMP,
    // Public evidence for open decision 6 (§9): a live testnet wallet's rootSecret reproduces its
    // exact 0zk address via this same path (engine 9.6.0). Secret NOT stored — verified transiently
    // via scripts/capture/verify-testnet-identity.ts (env-only input).
    testnetCrosscheck: {
      address: '0zk1qy4xqtzlh3qfhrg4d8xg0mr7qzna3kd6y6udwr4y4pjljaxlm5l43rv7j6fe3z53la5zz8nztyzg59wtgeswfy33gs8a5rl6vg5glsx7lyxr3tgkuld9cutqe08',
      result: 'byte-identical',
      note: 'reproduced from a live testnet wallet recovery secret; secret not stored',
    },
    vectors: captured,
  };
  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2) + '\n');

  console.log(`\n${'='.repeat(64)}`);
  console.log(`  ${captured.length} keyset vectors captured → ${path.relative(process.cwd(), OUT_FILE)}`);
  console.log('  All seeds reproduced byte-for-byte across independent passes.');
  console.log('='.repeat(64));
}

main().catch(async (err) => {
  console.error('\nSpike failed:', err);
  try { await shutdownEngine(); } catch { /* ignore */ }
  process.exit(1);
});
