/**
 * Derive the relayer's Railgun address (0zk...) from the Anvil deployer mnemonic.
 *
 * The relayer uses the deployer account (Anvil account 0). This script creates
 * a Railgun wallet from the same mnemonic to get the 0zk address for fee collection.
 *
 * Run: npx ts-node scripts/derive_relayer_railgun_address.ts
 *
 * Add the output to usdc-v2-frontend/src/config/relayer.ts as relayerRailgunAddress.
 */

import { initializeEngine, shutdownEngine } from '../lib/sdk/init';
import { createWallet, DEFAULT_ENCRYPTION_KEY } from '../lib/sdk/wallet';

// Anvil/Hardhat default mnemonic (produces account 0: 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266)
const ANVIL_DEPLOYER_MNEMONIC = 'test test test test test test test test test test test junk';

async function main() {
  console.log('Deriving relayer Railgun address...');
  console.log('  Mnemonic: (Anvil deployer - account 0)');
  console.log('');

  await initializeEngine('relayerderive');

  const wallet = await createWallet(
    DEFAULT_ENCRYPTION_KEY,
    ANVIL_DEPLOYER_MNEMONIC,
    0 // derivation index for first account
  );

  await shutdownEngine();

  console.log('');
  console.log('Relayer Railgun address (add to relayer config):');
  console.log('');
  console.log(`  relayerRailgunAddress: '${wallet.railgunAddress}'`);
  console.log('');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
