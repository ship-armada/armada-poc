/**
 * Test Prover Module
 *
 * Tests proof generation using the SDK's prover.
 *
 * Prerequisites:
 * 1. Hub chain must be running (anvil on port 8546)
 * 2. Railgun contracts must be deployed
 * 3. Wallet must have shielded balance
 *
 * Note: Full proof generation requires:
 * - Network loaded into engine (for merkle tree)
 * - Shielded balance in wallet
 * - This test focuses on prover initialization
 *
 * Run: npx ts-node lib/sdk/test-prover.ts
 */

import { initializeEngine, shutdownEngine, clearDatabase } from './init';
import { createWallet, DEFAULT_ENCRYPTION_KEY } from './wallet';
import { initializeProver, getProver, isProverInitialized } from './prover';

async function main() {
  console.log('='.repeat(60));
  console.log('  Prover Module Test');
  console.log('='.repeat(60));

  try {
    // Test 1: Initialize engine
    console.log('\n1. Initializing engine...');
    clearDatabase();
    await initializeEngine('cctppoc');
    console.log('   ✓ Engine initialized');

    // Test 2: Check prover state before init
    console.log('\n2. Checking prover state...');
    const proverBefore = isProverInitialized();
    console.log('   Prover initialized:', proverBefore);
    if (proverBefore) {
      console.log('   ⚠ Prover was already initialized');
    } else {
      console.log('   ✓ Prover not yet initialized (expected)');
    }

    // Test 3: Initialize prover with snarkjs
    console.log('\n3. Initializing prover...');
    await initializeProver();
    console.log('   ✓ Prover initialized');

    // Test 4: Check prover state after init
    console.log('\n4. Verifying prover state...');
    const proverAfter = isProverInitialized();
    console.log('   Prover initialized:', proverAfter);
    if (!proverAfter) throw new Error('Prover should be initialized');
    console.log('   ✓ Prover state verified');

    // Test 5: Get prover instance
    console.log('\n5. Getting prover instance...');
    const prover = getProver();
    console.log('   Prover instance:', !!prover);
    console.log('   Has groth16:', !!prover.groth16);
    if (!prover.groth16) throw new Error('Prover should have groth16 implementation');
    console.log('   ✓ Prover instance retrieved');

    // Test 6: Create wallet (needed for full proof test)
    console.log('\n6. Creating test wallet...');
    const walletInfo = await createWallet(DEFAULT_ENCRYPTION_KEY);
    console.log('   Wallet ID:', walletInfo.id.slice(0, 20) + '...');
    console.log('   Address:', walletInfo.railgunAddress.slice(0, 40) + '...');
    console.log('   ✓ Wallet created');

    // Note: Full proof generation test requires:
    // - Network loaded with deployed contracts
    // - Shielded balance in wallet
    // Those tests belong in integration tests with devnet

    console.log('\n7. Proof generation requires network and balance...');
    console.log('   (Full proof tests run in integration tests)');
    console.log('   ✓ Prover setup verified');

    // Shutdown
    console.log('\n8. Shutting down...');
    await shutdownEngine();
    console.log('   ✓ Shutdown complete');

    console.log('\n' + '='.repeat(60));
    console.log('  ALL TESTS PASSED');
    console.log('='.repeat(60));

  } catch (error) {
    console.error('\n✗ Test failed:', error);
    await shutdownEngine().catch(() => {});
    process.exit(1);
  }
}

main().catch(console.error);
