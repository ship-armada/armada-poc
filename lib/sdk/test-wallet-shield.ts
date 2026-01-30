/**
 * Test Wallet and Shield Operations
 *
 * Verifies that the SDK wallet creation and shield request
 * generation work correctly.
 */

import { initializeEngine, shutdownEngine, clearDatabase } from './init';
import {
  createWallet,
  getOrCreateWallet,
  decodeAddress,
  DEFAULT_ENCRYPTION_KEY,
} from './wallet';
import {
  createShieldRequest,
  createShieldRequestBatch,
  generateShieldPrivateKey,
  isValidRailgunAddress,
  isValidShieldPrivateKey,
  formatShieldRequest,
  parseUSDC,
} from './shield';

// Mock USDC address for testing
const MOCK_USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';

async function main() {
  console.log('='.repeat(60));
  console.log('  Wallet and Shield Operations Test');
  console.log('='.repeat(60));

  try {
    // Initialize engine
    console.log('\n1. Initializing engine...');
    clearDatabase();
    await initializeEngine('cctppoc');
    console.log('   ✓ Engine initialized');

    // Test 2: Create wallet
    console.log('\n2. Creating wallet...');
    const walletInfo = await createWallet(DEFAULT_ENCRYPTION_KEY);
    console.log('   Wallet ID:', walletInfo.id.slice(0, 20) + '...');
    console.log('   Address:', walletInfo.railgunAddress.slice(0, 40) + '...');
    console.log('   ✓ Wallet created');

    // Test 3: Validate address
    console.log('\n3. Validating Railgun address...');
    const isValid = isValidRailgunAddress(walletInfo.railgunAddress);
    console.log('   Is valid:', isValid);
    if (!isValid) throw new Error('Address validation failed');
    console.log('   ✓ Address is valid');

    // Test 4: Decode address
    console.log('\n4. Decoding Railgun address...');
    const decoded = decodeAddress(walletInfo.railgunAddress);
    console.log('   Master Public Key:', decoded.masterPublicKey.toString().slice(0, 30) + '...');
    console.log('   Viewing Public Key:', Buffer.from(decoded.viewingPublicKey).toString('hex').slice(0, 30) + '...');
    console.log('   ✓ Address decoded');

    // Test 5: Generate shield private key
    console.log('\n5. Generating shield private key...');
    const shieldPrivateKey = generateShieldPrivateKey();
    console.log('   Key:', shieldPrivateKey.slice(0, 20) + '...');
    console.log('   Length:', shieldPrivateKey.length, 'chars');
    const keyValid = isValidShieldPrivateKey(shieldPrivateKey);
    console.log('   Is valid:', keyValid);
    if (!keyValid) throw new Error('Shield private key validation failed');
    console.log('   ✓ Shield private key generated');

    // Test 6: Create single shield request
    console.log('\n6. Creating single shield request...');
    const amount = parseUSDC('100'); // 100 USDC
    const shieldResult = await createShieldRequest(
      {
        railgunAddress: walletInfo.railgunAddress,
        amount,
        tokenAddress: MOCK_USDC,
      },
      shieldPrivateKey
    );
    console.log('   Random:', shieldResult.random.slice(0, 20) + '...');
    console.log('   NPK:', shieldResult.shieldRequest.preimage.npk.toString().slice(0, 30) + '...');
    console.log('   Value:', shieldResult.shieldRequest.preimage.value.toString());
    console.log('   ✓ Single shield request created');

    // Test 7: Create batch shield requests
    console.log('\n7. Creating batch shield requests...');
    const batchResult = await createShieldRequestBatch(
      [
        { railgunAddress: walletInfo.railgunAddress, amount: parseUSDC('50'), tokenAddress: MOCK_USDC },
        { railgunAddress: walletInfo.railgunAddress, amount: parseUSDC('75'), tokenAddress: MOCK_USDC },
      ],
      shieldPrivateKey
    );
    console.log('   Batch size:', batchResult.shieldRequests.length);
    console.log('   Shared random:', batchResult.random.slice(0, 20) + '...');
    console.log('   Request 1 value:', batchResult.shieldRequests[0].preimage.value.toString());
    console.log('   Request 2 value:', batchResult.shieldRequests[1].preimage.value.toString());
    console.log('   ✓ Batch shield requests created');

    // Test 8: Get or create wallet (test persistence)
    console.log('\n8. Testing getOrCreateWallet...');
    const { wallet, info, isNew } = await getOrCreateWallet('test-wallet');
    console.log('   Is new:', isNew);
    console.log('   Wallet ID:', info.id.slice(0, 20) + '...');
    console.log('   ✓ getOrCreateWallet works');

    // Test 9: Format shield request
    console.log('\n9. Formatting shield request for display...');
    const formatted = formatShieldRequest(shieldResult.shieldRequest);
    console.log(formatted);
    console.log('   ✓ Shield request formatted');

    // Shutdown
    console.log('\n10. Shutting down...');
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
