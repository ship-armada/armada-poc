// ABOUTME: createArmadaSdk facade chain differential — drives the assembled SDK INSTANCE (sync →
// ABOUTME: planTransfer → prove → submit) end-to-end on-chain, validating the keystone as one unit.

/**
 * Facade Chain Differential: the createArmadaSdk instance path
 *
 * The tx differential validated the write-path COMPONENTS on-chain. This validates the assembled
 * INSTANCE: shield 10 USDC to Alice (stock SDK, to seed a note), then use ONLY the SDK instance API —
 * `createArmadaSdk` → `wallet.fromRootSecret` → `sync` → `balances` → `planTransfer` → `prove` →
 * `toTransactCalldata` — to transfer 3 USDC Alice → Bob, and submit it. On-chain success = the whole
 * keystone (provider wiring, persistent scan, plan, witness, prove, serialize) works together.
 *
 * Prerequisites (local):
 *   npm run chains                              # terminal 1
 *   source config/local.env && npm run setup    # terminal 2
 *   npx hardhat run scripts/capture/e2e-facade-differential.ts --network hub
 */

import { ethers } from 'hardhat';

import { initializeEngine, clearDatabase } from '../../lib/sdk/init';
import { createWallet, DEFAULT_ENCRYPTION_KEY } from '../../lib/sdk/wallet';
import { initializeProver } from '../../lib/sdk/prover';
import { createShieldRequest, generateShieldPrivateKey } from '../../lib/sdk/shield';
import { loadNetworkIntoEngine } from '../../lib/sdk/network';
import { getChainById, getRpcUrl } from '../../lib/sdk/chain-config';
import { loadDeployment } from '../deploy-utils';
import { getArtifact } from '../../lib/sdk/armada-artifacts';

import { POI, POINodeInterface } from '@railgun-community/engine';
import { Chain } from '@railgun-community/shared-models';

import { createArmadaSdk, createSnarkjsProver, MemoryStorageAdapter, LocalSigner, deriveKeyset } from '@armada/sdk';
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
  console.log('  Facade Chain Differential: createArmadaSdk instance');
  console.log('='.repeat(60));
  await initPoseidonPromise;

  const deployments = loadDeployment('privacy-pool-hub.json');
  if (!deployments) throw new Error('privacy-pool-hub.json not found — run `npm run setup` first');
  const chainId: number = deployments.chainId;
  const chain: Chain = getChainById(chainId)!;
  const deployBlock: number = deployments.deployBlock ?? 0;
  console.log(`\nNetwork: local (chainId ${chainId}), deployBlock ${deployBlock}`);

  const shieldAmount = ethers.parseUnits('10', 6);
  const transferAmount = ethers.parseUnits('3', 6);
  const aliceSigner = (await ethers.getSigners())[1];

  const privacyPool = await ethers.getContractAt('PrivacyPool', deployments.contracts.privacyPool);
  const poolAddress = (await privacyPool.getAddress()) as `0x${string}`;
  const usdc = await ethers.getContractAt('MockUSDCV2', deployments.cctp.usdc);
  const usdcAddress = (await usdc.getAddress()) as `0x${string}`;
  const usdcTokenHash = getTokenDataHash(getTokenDataERC20(usdcAddress));

  const aliceRoot = seed(0x11);
  const bobRoot = seed(0x22);
  const alice = await deriveKeyset(aliceRoot);
  const bob = await deriveKeyset(bobRoot);

  // ── Stock engine: shield 10 USDC to Alice (seed a spendable note) ──
  console.log('\nStock SDK: shield 10 USDC → Alice...');
  clearDatabase();
  await initializeEngine('facadediff');
  await loadNetworkIntoEngine(chain, poolAddress, ethers.ZeroAddress, getRpcUrl(chain), deployBlock);
  await initializeProver();
  const aliceInfo = await createWallet(DEFAULT_ENCRYPTION_KEY, Mnemonic.fromEntropy(bytesToHex(aliceRoot)), 0);
  if (aliceInfo.railgunAddress !== alice.railgunAddress) throw new Error('Alice derivation mismatch');

  const { shieldRequest } = await createShieldRequest(
    { railgunAddress: alice.railgunAddress, amount: shieldAmount, tokenAddress: usdcAddress },
    generateShieldPrivateKey(),
  );
  const aliceAddr = await aliceSigner.getAddress();
  await (await usdc.mint(aliceAddr, shieldAmount)).wait();
  await (await usdc.connect(aliceSigner).approve(poolAddress, shieldAmount)).wait();
  await (await privacyPool.connect(aliceSigner).shield([shieldRequest], ethers.ZeroAddress)).wait();
  console.log('✓ Shield mined');

  // ── Assemble the SDK instance (getArtifact-backed ArtifactSource, snarkjs prover, in-memory store) ──
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

  const balanceOf = async (wallet: { balances: () => Promise<Array<{ tokenHash: string; spendable: bigint; pending: bigint }>> }): Promise<bigint> => {
    const entry = (await wallet.balances()).find((b) => b.tokenHash === usdcTokenHash);
    return entry ? entry.spendable + entry.pending : 0n;
  };

  // ── Instance API: sync → balance → planTransfer → prove → submit ──
  console.log('\nSDK instance: Alice sync + plan + prove...');
  const aliceWallet = await sdk.wallet.fromRootSecret(aliceRoot, { creationBlock: deployBlock, signer: await LocalSigner.fromRootSecret(aliceRoot) });
  await aliceWallet.sync();
  const preBalance = await balanceOf(aliceWallet);
  console.log(`  Alice synced balance: ${fmt(preBalance)} USDC (expect 9.95)`);
  if (preBalance !== ethers.parseUnits('9.95', 6)) throw new Error(`unexpected pre-transfer balance ${preBalance}`);

  const fee = { schedule: { transfer: '0' }, broadcasterRailgunAddress: bob.railgunAddress, feesCacheId: 'x', expiresAt: 0 };
  const plan = await aliceWallet.planTransfer({ outputs: [{ to0zk: bob.railgunAddress, amount: transferAmount }], fee });
  console.log(`  plan shape ${plan.shape.nullifiers}x${plan.shape.commitments}, change ${fmt(plan.summary.changeValue)} USDC`);
  const proofHandle = await aliceWallet.prove(plan);
  const calldata = proofHandle.toTransactCalldata();

  console.log('\nSubmitting instance-built transact() on-chain...');
  const rcpt = await (await aliceSigner.sendTransaction({ to: calldata.to, data: calldata.data })).wait();
  console.log(`✓ transact mined (block ${rcpt!.blockNumber}) — ON-CHAIN GROTH16 VERIFICATION PASSED`);

  // ── Re-sync via the instance API and confirm balances ──
  await aliceWallet.sync();
  const alicePost = await balanceOf(aliceWallet);
  const bobWallet = await sdk.wallet.fromRootSecret(bobRoot, { creationBlock: deployBlock });
  await bobWallet.sync();
  const bobPost = await balanceOf(bobWallet);

  console.log('\n' + '─'.repeat(50));
  console.log(`  INSTANCE  Alice: ${fmt(alicePost)}  Bob: ${fmt(bobPost)} USDC`);
  console.log(`  EXPECT    Alice: 6.95  Bob: 3.0 USDC`);
  if (alicePost !== ethers.parseUnits('6.95', 6) || bobPost !== transferAmount) {
    throw new Error(`INSTANCE BALANCE MISMATCH (Alice ${alicePost} Bob ${bobPost})`);
  }
  console.log('  ✓ FACADE DIFFERENTIAL PASS — createArmadaSdk instance drives a transfer on-chain');
  console.log('─'.repeat(50));

  await sdk.close();
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
