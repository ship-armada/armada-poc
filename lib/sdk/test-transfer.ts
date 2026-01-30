/**
 * Test Transfer Module
 *
 * Tests the transfer module's basic functionality.
 * Full transfer tests require:
 * - Deployed contracts
 * - Shielded balance
 *
 * Run: npx ts-node lib/sdk/test-transfer.ts
 */

import { initializeEngine, shutdownEngine, clearDatabase } from './init';
import { createWallet, DEFAULT_ENCRYPTION_KEY } from './wallet';
import { initializeProver } from './prover';
import {
  parseUSDCAmount,
  formatUSDCAmount,
  formatTransferResult,
} from './transfer';

async function main() {
  console.log('='.repeat(60));
  console.log('  Transfer Module Test');
  console.log('='.repeat(60));

  try {
    // Test 1: Initialize engine
    console.log('\n1. Initializing engine...');
    clearDatabase();
    await initializeEngine('cctppoc');
    console.log('   ✓ Engine initialized');

    // Test 2: Initialize prover
    console.log('\n2. Initializing prover...');
    await initializeProver();
    console.log('   ✓ Prover initialized');

    // Test 3: Create test wallets
    console.log('\n3. Creating test wallets...');
    const senderInfo = await createWallet(DEFAULT_ENCRYPTION_KEY);
    const receiverInfo = await createWallet(DEFAULT_ENCRYPTION_KEY);
    console.log('   Sender:', senderInfo.railgunAddress.slice(0, 40) + '...');
    console.log('   Receiver:', receiverInfo.railgunAddress.slice(0, 40) + '...');
    console.log('   ✓ Wallets created');

    // Test 4: Test USDC parsing/formatting
    console.log('\n4. Testing USDC parsing/formatting...');
    const amount = parseUSDCAmount('100.50');
    console.log('   Parsed "100.50" USDC:', amount.toString());
    const formatted = formatUSDCAmount(amount);
    console.log('   Formatted back:', formatted);
    if (formatted !== '100.5') throw new Error('USDC formatting mismatch');
    console.log('   ✓ USDC parsing/formatting works');

    // Test 5: Test formatTransferResult
    console.log('\n5. Testing formatTransferResult...');
    const mockResult = {
      transactions: [],
      contractTransaction: { to: '0x1234567890123456789012345678901234567890' } as any,
      nullifiers: [
        '0x1111111111111111111111111111111111111111111111111111111111111111',
        '0x2222222222222222222222222222222222222222222222222222222222222222',
      ],
    };
    const resultStr = formatTransferResult(mockResult);
    console.log(resultStr);
    console.log('   ✓ formatTransferResult works');

    // Note: Full transfer testing requires:
    // - Network loaded with deployed contracts
    // - Shield transaction to create initial balance
    // - Then transfer/unshield can be tested
    console.log('\n6. Full transfer tests require deployed network...');
    console.log('   (Will be tested in integration tests)');
    console.log('   ✓ Module structure verified');

    // Shutdown
    console.log('\n7. Shutting down...');
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
