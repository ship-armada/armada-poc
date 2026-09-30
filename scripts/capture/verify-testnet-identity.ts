// ABOUTME: Phase 0 Spike 1 cross-check — proves a live testnet wallet's rootSecret reproduces its
// ABOUTME: 0zk address via the spike derivation path. Reads the secret from env; NEVER writes it anywhere.
//
// Throwaway. Secret comes from CROSSCHECK_ROOTSECRET (hex, no persistence); expected 0zk from
// CROSSCHECK_EXPECTED_0ZK. Prints PASS/FAIL + the derived (public) 0zk only. No file output.
//
// Run: CROSSCHECK_ROOTSECRET=<hex> CROSSCHECK_EXPECTED_0ZK=<0zk...> npx ts-node scripts/capture/verify-testnet-identity.ts

import { entropyToMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { RailgunWallet, POI, POINodeInterface } from '@railgun-community/engine';
import { initializeEngine, shutdownEngine, clearDatabase } from '../../lib/sdk/init';

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

const ENC_KEY = '0101010101010101010101010101010101010101010101010101010101010101';

async function main() {
  const rootSecretHex = (process.env.CROSSCHECK_ROOTSECRET ?? '').replace(/^0x/, '').trim();
  const expected = (process.env.CROSSCHECK_EXPECTED_0ZK ?? '').trim();
  if (rootSecretHex.length !== 64) {
    throw new Error(`CROSSCHECK_ROOTSECRET must be 64 hex chars, got ${rootSecretHex.length}`);
  }
  if (!expected.startsWith('0zk')) {
    throw new Error('CROSSCHECK_EXPECTED_0ZK must be a 0zk... address');
  }

  const rootSecret = new Uint8Array(Buffer.from(rootSecretHex, 'hex'));
  // Same path as apps/armada-interface/src/lib/crypto/kdf.ts::deriveInternalMnemonic.
  const mnemonic = entropyToMnemonic(rootSecret, wordlist);

  clearDatabase();
  const engine = await initializeEngine('xcheck');
  let derived = '';
  try {
    const info = await engine.createWalletFromMnemonic(ENC_KEY, mnemonic, 0, undefined);
    const wallet = engine.wallets[info.id] as RailgunWallet;
    derived = wallet.getAddress();
  } finally {
    rootSecret.fill(0); // zeroize local secret copy
    await shutdownEngine();
  }

  const match = derived === expected;
  console.log('\n' + '='.repeat(64));
  console.log('  Testnet identity cross-check (engine 9.6.0)');
  console.log('='.repeat(64));
  console.log('  derived 0zk :', derived);
  console.log('  expected 0zk:', expected);
  console.log('  result      :', match ? '✓ PASS — byte-identical' : '✗ FAIL — mismatch');
  console.log('='.repeat(64));
  if (!match) process.exit(2);
}

main().catch(async (err) => {
  console.error('\nCross-check failed:', err);
  try { await shutdownEngine(); } catch { /* ignore */ }
  process.exit(1);
});
