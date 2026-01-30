/**
 * Test Network Loading and Merkle Tree Sync
 *
 * Prerequisites:
 * 1. Hub chain must be running (anvil on port 8546)
 * 2. Railgun contracts must be deployed (run deploy_railgun.ts)
 *
 * Run: npx ts-node lib/sdk/test-network.ts
 */

import { initializeEngine, shutdownEngine, clearDatabase } from './init';
import {
  loadDeployment,
  listDeployments,
  loadNetworkIntoEngine,
  loadHubNetwork,
  getMerkleRoot,
} from './network';
import { HUB_CHAIN, HUB_RPC, DEPLOYMENT_BLOCK } from './chain-config';
import { ethers } from 'ethers';

async function main() {
  console.log('='.repeat(60));
  console.log('  Network Loading and Merkle Tree Test');
  console.log('='.repeat(60));

  try {
    // Test 1: List deployments
    console.log('\n1. Listing available deployments...');
    const deployments = listDeployments();
    console.log('   Deployments:', deployments);
    if (deployments.length === 0) {
      console.log('   ⚠ No deployments found. Run deploy_railgun.ts first.');
      console.log('   Skipping remaining tests.');
      return;
    }
    console.log('   ✓ Found deployments');

    // Test 2: Load deployment info
    console.log('\n2. Loading railgun deployment...');
    const deployment = loadDeployment('railgun');
    console.log('   Chain ID:', deployment.chainId);
    console.log('   Railgun Proxy:', deployment.contracts.railgunProxy);
    console.log('   Testing Mode:', deployment.config.testingMode);
    console.log('   Verification Keys:', deployment.config.verificationKeysLoaded.join(', '));
    console.log('   ✓ Deployment loaded');

    // Test 3: Check if hub chain is running
    console.log('\n3. Checking hub chain connectivity...');
    const provider = new ethers.JsonRpcProvider(HUB_RPC);
    try {
      const blockNumber = await provider.getBlockNumber();
      console.log('   Block number:', blockNumber);
      console.log('   ✓ Hub chain is running');
    } catch (error) {
      console.log('   ⚠ Hub chain not running. Start with: npm run start:hub');
      console.log('   Skipping engine tests.');
      return;
    }

    // Test 4: Initialize engine
    console.log('\n4. Initializing engine...');
    clearDatabase();
    await initializeEngine('cctppoc');
    console.log('   ✓ Engine initialized');

    // Test 5: Load network
    console.log('\n5. Loading network into engine...');
    const networkResult = await loadHubNetwork();
    console.log('   Chain:', `${networkResult.chain.type}:${networkResult.chain.id}`);
    console.log('   Railgun Proxy:', networkResult.railgunProxy);
    console.log('   Shield Fee:', networkResult.fees.shield.toString(), 'basis points');
    console.log('   Unshield Fee:', networkResult.fees.unshield.toString(), 'basis points');
    console.log('   ✓ Network loaded');

    // Test 6: Get merkle root
    console.log('\n6. Getting merkle root...');
    const root = await getMerkleRoot(HUB_CHAIN, 0);
    if (root) {
      console.log('   Root:', root.slice(0, 30) + '...');
      console.log('   ✓ Merkle root retrieved');
    } else {
      console.log('   Root: (empty tree - no shields yet)');
      console.log('   ✓ Merkle tree accessible');
    }

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
