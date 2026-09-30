// ABOUTME: Shield chain differential — the @armada/sdk builds the shield request natively
// ABOUTME: (buildShieldRequest), submits it, and both the armada scan AND the stock SDK recover it.

/**
 * Shield Chain Differential: @armada/sdk buildShieldRequest vs the deployed pool
 *
 * The last write-path validation: a shield request built ENTIRELY by @armada/sdk
 * (`buildShieldRequest`) is accepted on-chain and decrypts to the recipient. Both the armada scan
 * (instance API) and the stock Railgun SDK independently recover the shielded balance.
 *
 * Prerequisites (local):
 *   npm run chains                              # terminal 1
 *   source config/local.env && npm run setup    # terminal 2
 *   npx hardhat run scripts/capture/e2e-shield-differential.ts --network hub
 */

import { ethers } from 'hardhat';

import { initializeEngine, clearDatabase } from '../../lib/sdk/init';
import { createWallet, DEFAULT_ENCRYPTION_KEY } from '../../lib/sdk/wallet';
import { loadNetworkIntoEngine, scanWalletBalances, getWalletBalances } from '../../lib/sdk/network';
import { getChainById, getRpcUrl } from '../../lib/sdk/chain-config';
import { loadDeployment } from '../deploy-utils';
import { getArtifact } from '../../lib/sdk/armada-artifacts';

import {
  POI, POINodeInterface,
  getTokenDataERC20 as engineTokenDataERC20, getTokenDataHash as engineTokenDataHash,
} from '@railgun-community/engine';
import { Chain } from '@railgun-community/shared-models';

import { createArmadaSdk, createSnarkjsProver, MemoryStorageAdapter, deriveKeyset, buildShieldRequest, generateShieldPrivateKey } from '@armada/sdk';
import type { ArtifactSource, CircuitShape } from '@armada/sdk';
import { Mnemonic, getTokenDataERC20, getTokenDataHash, initPoseidonPromise } from '@armada/sdk/core';

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

const bytesToHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const seed = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);
const fmt = (v: bigint): string => ethers.formatUnits(v, 6);

async function main() {
  console.log('='.repeat(60));
  console.log('  Shield Chain Differential: @armada/sdk buildShieldRequest');
  console.log('='.repeat(60));
  await initPoseidonPromise;

  const deployments = loadDeployment('privacy-pool-hub.json');
  if (!deployments) throw new Error('privacy-pool-hub.json not found — run `npm run setup` first');
  const chainId: number = deployments.chainId;
  const chain: Chain = getChainById(chainId)!;
  const deployBlock: number = deployments.deployBlock ?? 0;
  console.log(`\nNetwork: local (chainId ${chainId}), deployBlock ${deployBlock}`);

  const shieldAmount = ethers.parseUnits('10', 6);
  const expected = ethers.parseUnits('9.95', 6); // 10 − 50bps shield fee
  const aliceSigner = (await ethers.getSigners())[1];

  const privacyPool = await ethers.getContractAt('PrivacyPool', deployments.contracts.privacyPool);
  const poolAddress = (await privacyPool.getAddress()) as `0x${string}`;
  const usdc = await ethers.getContractAt('MockUSDCV2', deployments.cctp.usdc);
  const usdcAddress = (await usdc.getAddress()) as `0x${string}`;

  const aliceRoot = seed(0x11);
  const alice = await deriveKeyset(aliceRoot);

  // ── SDK builds the shield request natively, then we submit it on-chain ──
  console.log('\n@armada/sdk: buildShieldRequest(10 USDC → Alice)...');
  const { shieldRequest } = await buildShieldRequest(
    { railgunAddress: alice.railgunAddress, amount: shieldAmount, tokenAddress: usdcAddress },
    generateShieldPrivateKey(),
  );
  const aliceAddr = await aliceSigner.getAddress();
  await (await usdc.mint(aliceAddr, shieldAmount)).wait();
  await (await usdc.connect(aliceSigner).approve(poolAddress, shieldAmount)).wait();
  const rcpt = await (await privacyPool.connect(aliceSigner).shield([shieldRequest], ethers.ZeroAddress)).wait();
  console.log(`✓ Shield mined (block ${rcpt!.blockNumber}) — pool accepted the SDK-built request`);

  // ── Armada scan (instance API) recovers the balance ──
  const artifacts: ArtifactSource = {
    resolve: async (shape: CircuitShape) => {
      const a = getArtifact(shape.nullifiers, shape.commitments);
      return { wasm: new Uint8Array(a.wasm), zkey: new Uint8Array(a.zkey), vkey: a.vkey };
    },
  };
  const sdk = await createArmadaSdk({
    pool: { chainId, poolAddress, deployBlock, usdcAddress },
    rpc: { urls: ['http://localhost:8545'] },
    storage: new MemoryStorageAdapter(),
    prover: createSnarkjsProver(),
    artifacts,
  });
  const aliceWallet = await sdk.wallet.fromRootSecret(aliceRoot, { creationBlock: deployBlock });
  await aliceWallet.sync();
  const armadaHash = getTokenDataHash(getTokenDataERC20(usdcAddress));
  const armadaEntry = (await aliceWallet.balances()).find((b) => b.tokenHash === armadaHash);
  const armadaBalance = armadaEntry ? armadaEntry.spendable + armadaEntry.pending : 0n;

  // ── Stock SDK independently recovers the same balance ──
  clearDatabase();
  await initializeEngine('shielddiff');
  await loadNetworkIntoEngine(chain, poolAddress, ethers.ZeroAddress, getRpcUrl(chain), deployBlock);
  const stockInfo = await createWallet(DEFAULT_ENCRYPTION_KEY, Mnemonic.fromEntropy(bytesToHex(aliceRoot)), 0);
  await scanWalletBalances(stockInfo.id, chain);
  const stockHash = engineTokenDataHash(engineTokenDataERC20(usdcAddress));
  const stockBalance = (await getWalletBalances(stockInfo.id, chain, false))[stockHash]?.balance ?? 0n;

  console.log('\n' + '─'.repeat(50));
  console.log(`  ARMADA ${fmt(armadaBalance)}  STOCK ${fmt(stockBalance)}  EXPECT ${fmt(expected)} USDC`);
  if (armadaBalance !== expected || stockBalance !== expected) {
    throw new Error(`SHIELD MISMATCH — armada ${armadaBalance} stock ${stockBalance} expected ${expected}`);
  }
  console.log('  ✓ SHIELD DIFFERENTIAL PASS — SDK-built shield accepted on-chain + recovered by both backends');
  console.log('─'.repeat(50));

  await sdk.close();
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
