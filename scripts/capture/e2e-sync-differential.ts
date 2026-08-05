// ABOUTME: Sync differential — shields + privately transfers USDC via the stock Railgun SDK on local
// ABOUTME: Anvil, then scans the same chain with @armada/sdk and asserts identical shielded balances.

/**
 * Sync Differential: stock SDK vs @armada/sdk
 *
 * Validates the armada sync engine (event-decoder + note/shield decrypt + merkletree + nullifiers +
 * balances) against the reference implementation on a real chain:
 *   1. SHIELD 10 USDC to Alice (direct contract call — no ZK proof).
 *   2. TRANSFER 3 USDC Alice → Bob (real Groth16 proof via the stock SDK).
 * After each step every wallet's stock balance is compared to an independent @armada/sdk scan.
 *
 * Prerequisites (local):
 *   npm run chains                              # terminal 1
 *   source config/local.env && npm run setup    # terminal 2
 *   npx hardhat run scripts/capture/e2e-sync-differential.ts --network hub
 */

import { ethers } from 'hardhat';

import { initializeEngine, shutdownEngine, clearDatabase, getEngine } from '../../lib/sdk/init';
import { createWallet, DEFAULT_ENCRYPTION_KEY } from '../../lib/sdk/wallet';
import { initializeProver } from '../../lib/sdk/prover';
import { createShieldRequest, generateShieldPrivateKey } from '../../lib/sdk/shield';
import { loadNetworkIntoEngine, scanWalletBalances, getWalletBalances } from '../../lib/sdk/network';
import { createPrivateTransfer } from '../../lib/sdk/transfer';
import { getChainById, getRpcUrl } from '../../lib/sdk/chain-config';
import { loadDeployment } from '../deploy-utils';
import { scanArmadaBalances } from '../../lib/sdk/armada-sync';

import {
  TXIDVersion, POI, POINodeInterface, RailgunWallet,
  getTokenDataERC20 as engineTokenDataERC20, getTokenDataHash as engineTokenDataHash,
} from '@railgun-community/engine';
import { Chain } from '@railgun-community/shared-models';
import { Mnemonic } from '@armada/sdk/core';
import { deriveKeyset, type Keyset } from '@armada/sdk';
import { getTokenDataERC20, getTokenDataHash } from '@armada/sdk/core';

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

interface DiffWallet {
  label: string;
  walletId: string;
  railgunAddress: string;
  wallet: RailgunWallet;
  keyset: Keyset;
}

async function main() {
  console.log('='.repeat(60));
  console.log('  Sync Differential: stock SDK vs @armada/sdk');
  console.log('='.repeat(60));

  const deployments = loadDeployment('privacy-pool-hub.json');
  if (!deployments) throw new Error('privacy-pool-hub.json not found — run `npm run setup` first');
  const chainId: number = deployments.chainId;
  const chain: Chain = getChainById(chainId)!;
  console.log(`\nNetwork: local (chainId ${chainId}), deployBlock ${deployments.deployBlock}`);

  const shieldAmount = ethers.parseUnits('10', 6);
  const transferAmount = ethers.parseUnits('3', 6);

  const signers = await ethers.getSigners();
  const aliceSigner = signers[1];

  const privacyPool = await ethers.getContractAt('PrivacyPool', deployments.contracts.privacyPool);
  const usdc = await ethers.getContractAt('MockUSDCV2', deployments.cctp.usdc);
  const usdcAddress = await usdc.getAddress();
  const stockTokenHash = engineTokenDataHash(engineTokenDataERC20(usdcAddress));
  const armadaTokenHash = getTokenDataHash(getTokenDataERC20(usdcAddress));

  // ── Init stock engine + prover ──
  console.log('\nInitializing stock engine + prover...');
  clearDatabase();
  await initializeEngine('diff');
  await loadNetworkIntoEngine(chain, await privacyPool.getAddress(), ethers.ZeroAddress, getRpcUrl(chain), deployments.deployBlock ?? 0);
  await initializeProver();

  // ── Derive Alice + Bob on both backends from fixed rootSecrets ──
  async function makeWallet(label: string, rootSecret: Uint8Array): Promise<DiffWallet> {
    const keyset = await deriveKeyset(rootSecret);
    const info = await createWallet(DEFAULT_ENCRYPTION_KEY, Mnemonic.fromEntropy(bytesToHex(rootSecret)), 0);
    if (info.railgunAddress !== keyset.railgunAddress) {
      throw new Error(`${label}: rootSecret derivation mismatch (stock ${info.railgunAddress} vs armada ${keyset.railgunAddress})`);
    }
    const wallet = getEngine().wallets[info.id] as unknown as RailgunWallet;
    console.log(`  ${label}: ${info.railgunAddress}`);
    return { label, walletId: info.id, railgunAddress: info.railgunAddress, wallet, keyset };
  }
  const alice = await makeWallet('Alice', seed(0x11));
  const bob = await makeWallet('Bob', seed(0x22));

  // ── Assert one wallet's stock balance == an independent armada scan ──
  async function assertDifferential(w: DiffWallet, phase: string): Promise<bigint> {
    await scanWalletBalances(w.walletId, chain);
    const stock = (await getWalletBalances(w.walletId, chain, false))[stockTokenHash]?.balance ?? 0n;

    const headBlock = await ethers.provider.getBlockNumber();
    const armadaBalances = await scanArmadaBalances({
      provider: ethers.provider,
      poolAddress: await privacyPool.getAddress(),
      deployBlock: deployments.deployBlock ?? 0,
      headBlock,
      chainId,
      tokenAddresses: [usdcAddress],
      wallet: {
        masterPublicKey: w.keyset.masterPublicKey,
        viewingPublicKey: w.keyset.viewingPublicKey,
        viewingPrivateKey: w.keyset.viewingPrivateKey,
        nullifyingKey: w.keyset.nullifyingKey,
      },
    });
    const entry = armadaBalances.find((b) => b.tokenHash === armadaTokenHash);
    const armada = entry ? entry.spendable + entry.pending : 0n;

    const tag = `[${phase}] ${w.label}`;
    console.log(`  ${tag}: stock=${ethers.formatUnits(stock, 6)}  armada=${ethers.formatUnits(armada, 6)} USDC`);
    if (stock !== armada) throw new Error(`DIFFERENTIAL MISMATCH ${tag}: stock=${stock} armada=${armada}`);
    return stock;
  }

  // ── STEP 1: SHIELD 10 USDC to Alice ──
  console.log(`\nSHIELD ${ethers.formatUnits(shieldAmount, 6)} USDC → Alice`);
  const shieldPrivateKey = generateShieldPrivateKey();
  const { shieldRequest } = await createShieldRequest(
    { railgunAddress: alice.railgunAddress, amount: shieldAmount, tokenAddress: usdcAddress },
    shieldPrivateKey,
  );
  const aliceAddr = await aliceSigner.getAddress();
  await (await usdc.mint(aliceAddr, shieldAmount)).wait();
  await (await usdc.connect(aliceSigner).approve(await privacyPool.getAddress(), shieldAmount)).wait();
  await (await privacyPool.connect(aliceSigner).shield([shieldRequest], ethers.ZeroAddress)).wait();

  const aliceAfterShield = await assertDifferential(alice, 'post-shield');
  if (aliceAfterShield === 0n) throw new Error('shield did not register — differential vacuous');

  // ── STEP 2: PRIVATE TRANSFER 3 USDC Alice → Bob (real Groth16) ──
  console.log(`\nTRANSFER ${ethers.formatUnits(transferAmount, 6)} USDC  Alice → Bob (proving`);
  const transferResult = await createPrivateTransfer({
    wallet: alice.wallet,
    chain,
    tokenAddress: usdcAddress,
    recipientAddress: bob.railgunAddress,
    amount: transferAmount,
    encryptionKey: DEFAULT_ENCRYPTION_KEY,
    progressCallback: () => process.stdout.write('.'),
  });
  process.stdout.write(')\n');
  await (await aliceSigner.sendTransaction({
    to: transferResult.contractTransaction.to,
    data: transferResult.contractTransaction.data,
  })).wait();
  const proved = transferResult.transactions[0];
  console.log(`✓ Transfer mined — circuit shape ${proved.nullifiers.length}x${proved.commitments.length}`);

  // Alice: shield note nullified + change note; Bob: received note. Both backends must agree.
  const aliceAfterTransfer = await assertDifferential(alice, 'post-transfer');
  const bobAfterTransfer = await assertDifferential(bob, 'post-transfer');

  console.log('\n' + '─'.repeat(50));
  console.log('  ✓ DIFFERENTIAL PASS — armada sync reproduces stock balances');
  console.log(`     Alice: ${ethers.formatUnits(aliceAfterShield, 6)} → ${ethers.formatUnits(aliceAfterTransfer, 6)} USDC (spent shield note + change)`);
  console.log(`     Bob:   0.0 → ${ethers.formatUnits(bobAfterTransfer, 6)} USDC (received transfer)`);
  console.log('─'.repeat(50));

  await shutdownEngine();
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
