/**
 * Test SDK Initialization
 *
 * Verifies that the SDK packages are installed correctly
 * and the engine can be initialized.
 */

import { initializeEngine, shutdownEngine, clearDatabase } from './init';
import { HUB_CHAIN } from './chain-config';
import { RailgunEngine, Mnemonic } from '@railgun-community/engine';

async function main() {
  console.log('='.repeat(60));
  console.log('  SDK Initialization Test');
  console.log('='.repeat(60));

  try {
    // Test 1: Check imports work
    console.log('\n1. Testing SDK imports...');
    console.log('   RailgunEngine:', typeof RailgunEngine);
    console.log('   Mnemonic:', typeof Mnemonic);
    console.log('   ✓ Imports successful');

    // Test 2: Generate mnemonic
    console.log('\n2. Testing mnemonic generation...');
    const mnemonic = Mnemonic.generate();
    console.log('   Generated mnemonic:', mnemonic.split(' ').length, 'words');
    const isValid = Mnemonic.validate(mnemonic);
    console.log('   Valid:', isValid);
    if (!isValid) throw new Error('Generated mnemonic is invalid');
    console.log('   ✓ Mnemonic generation works');

    // Test 3: Initialize engine
    console.log('\n3. Testing engine initialization...');
    clearDatabase(); // Start fresh
    const engine = await initializeEngine('cctppoc');
    console.log('   Engine initialized:', !!engine);
    console.log('   ✓ Engine initialization works');

    // Test 4: Create wallet
    console.log('\n4. Testing wallet creation...');
    // Encryption key must be 32 bytes (64 hex chars, no 0x prefix)
    const encryptionKey = '0123456789abcdef'.repeat(4);
    const wallet = await engine.createWalletFromMnemonic(
      encryptionKey,
      mnemonic,
      0, // derivation index
      undefined // creation block numbers
    );
    console.log('   Wallet ID:', wallet.id.slice(0, 20) + '...');
    console.log('   ✓ Wallet creation works');

    // Test 5: Get Railgun address
    console.log('\n5. Testing address generation...');
    const address = wallet.getAddress();
    console.log('   Railgun address:', address.slice(0, 30) + '...');
    console.log('   Starts with 0zk:', address.startsWith('0zk'));
    if (!address.startsWith('0zk')) throw new Error('Invalid Railgun address');
    console.log('   ✓ Address generation works');

    // Shutdown
    console.log('\n6. Shutting down...');
    await shutdownEngine();
    console.log('   ✓ Shutdown complete');

    console.log('\n' + '='.repeat(60));
    console.log('  ALL TESTS PASSED');
    console.log('='.repeat(60));

  } catch (error) {
    console.error('\n✗ Test failed:', error);
    process.exit(1);
  }
}

main().catch(console.error);
