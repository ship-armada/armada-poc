// ABOUTME: End-to-end verification of cross-chain unshield — shield on the hub, then atomicCrossChainUnshield
// ABOUTME: with a real Armada proof binding the CCTP destination; the relayer delivers USDC to the recipient on the client chain.

/**
 * End-to-End: Cross-Chain Unshield
 *
 * Flow:
 *   1. Shield USDC into the hub PrivacyPool.
 *   2. atomicCrossChainUnshield: SDK generates an Armada proof whose adaptParams bind the CCTP
 *      destination (finalRecipient, domain, maxFee); the hub burns USDC via CCTP to the client chain.
 *   3. The relayer picks up the hub MessageSent, gets the CCTP attestation, and delivers to the
 *      client chain's CCTPHookRouter → USDC is minted to finalRecipient. We poll the client chain
 *      until the recipient's balance increases.
 *
 * This is the only end-to-end exercise of the #364/#399 destination-binding: the proof itself
 * preventing the relayer from redirecting the exit.
 *
 * REQUIRES A RUNNING RELAYER (it completes the destination side):
 *   local   : npm run armada-relayer          (CCTP_MODE=mock)
 *   sepolia : npm run relayer:sepolia         (CCTP_MODE=real, Iris attestation)
 *
 * Prerequisites (local):
 *   npm run chains ; source config/local.env && npm run setup ; npm run armada-relayer
 *   npx hardhat run scripts/capture/e2e-xchain-unshield.ts --network hub
 *
 * Prerequisites (sepolia): deployer pre-funded with ~10 USDC + ETH on Ethereum Sepolia; relayer up.
 *   source config/sepolia.env
 *   npx hardhat run scripts/capture/e2e-xchain-unshield.ts --network sepoliaHub
 */

import { ethers } from 'hardhat';

import { initializeEngine, shutdownEngine, clearDatabase, getEngine } from '../../lib/sdk/init';
import { createWallet, DEFAULT_ENCRYPTION_KEY } from '../../lib/sdk/wallet';
import { initializeProver } from '../../lib/sdk/prover';
import { createShieldRequest, generateShieldPrivateKey } from '../../lib/sdk/shield';
import { loadNetworkIntoEngine, scanWalletBalances } from '../../lib/sdk/network';
import { getSpendableBalance } from '../../lib/sdk/transfer';
import { buildXchainUnshieldTransaction } from '../../lib/sdk/xchain-unshield';
import { getChainById, getRpcUrl } from '../../lib/sdk/chain-config';
import { getNetworkConfig, isLocal } from '../../config/networks';
import { loadDeployment } from '../deploy-utils';

import { TXIDVersion, POI, POINodeInterface, RailgunWallet } from '@railgun-community/engine';
import { ChainType, Chain } from '@railgun-community/shared-models';

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

const ERC20_BALANCE_ABI = ['function balanceOf(address) view returns (uint256)'];

/** Poll the SDK merkletree scan until the wallet's spendable balance reaches at least `minAmount`. */
async function waitForBalance(
  walletId: string, chain: Chain, wallet: RailgunWallet, tokenAddress: string, minAmount: bigint, label: string, timeoutMs: number,
): Promise<bigint> {
  const start = Date.now();
  let attempt = 0;
  while (Date.now() - start < timeoutMs) {
    await scanWalletBalances(walletId, chain);
    const bal = await getSpendableBalance(wallet, chain, tokenAddress);
    if (bal >= minAmount) return bal;
    attempt += 1;
    console.log(`  (scan ${attempt}: shielded balance ${ethers.formatUnits(bal, 6)} < ${ethers.formatUnits(minAmount, 6)} — waiting…)`);
    await new Promise(r => setTimeout(r, 5000));
  }
  throw new Error(`${label}: shielded balance didn't reach ${ethers.formatUnits(minAmount, 6)} within ${timeoutMs / 1000}s`);
}

/** Poll the destination chain until `recipient`'s USDC balance rises by at least `minIncrease` over `baseline`. */
async function waitForClientDelivery(
  usdc: any, recipient: string, baseline: bigint, minIncrease: bigint, timeoutMs: number, relayerHint: string,
): Promise<bigint> {
  const start = Date.now();
  let attempt = 0;
  while (Date.now() - start < timeoutMs) {
    const bal: bigint = await usdc.balanceOf(recipient);
    if (bal - baseline >= minIncrease) return bal;
    attempt += 1;
    const elapsed = Math.round((Date.now() - start) / 1000);
    console.log(`  (poll ${attempt}, ${elapsed}s: delivered ${ethers.formatUnits(bal - baseline, 6)} / ${ethers.formatUnits(minIncrease, 6)} USDC — waiting for relayer + CCTP…)`);
    await new Promise(r => setTimeout(r, 6000));
  }
  throw new Error(
    `Cross-chain delivery didn't arrive within ${timeoutMs / 1000}s. Is the relayer running ` +
    `(${relayerHint})? Check its logs for the CCTP relay of the hub burn.`,
  );
}

async function main() {
  console.log('='.repeat(60));
  console.log('  End-to-End: Cross-Chain Unshield (hub → client)');
  console.log('='.repeat(60));

  const config = getNetworkConfig();
  const local = isLocal();
  const suffix = local ? '' : `-${config.env}`;

  const hubDeployment = loadDeployment(`privacy-pool-hub${suffix}.json`);
  if (!hubDeployment) throw new Error(`privacy-pool-hub${suffix}.json not found — deploy first`);
  const clientDeployment = loadDeployment(`privacy-pool-client${suffix}.json`);
  if (!clientDeployment) throw new Error(`privacy-pool-client${suffix}.json not found — deploy the client chain first`);

  const destinationDomain = config.clients[0].cctpDomain;
  console.log(`\nHub: ${config.env} (chainId ${hubDeployment.chainId}) → Client A (chainId ${clientDeployment.chainId}, CCTP domain ${destinationDomain})`);
  console.log(`Relayer required: ${local ? 'npm run armada-relayer (mock CCTP)' : 'npm run relayer:sepolia (real CCTP)'}`);

  // atomicCrossChainUnshield = proof-verify (~500k) + CCTP burn/message (~250k); give ample headroom.
  const overrides = local ? {} : { gasLimit: 3_000_000n };
  const scanTimeoutMs = local ? 20_000 : 150_000;
  // CCTP delivery: even the mock relay isn't instant — the relayer's cctp-relay uses exponential
  // backoff (2+4+8+16+32 ≈ 62s for 5 attempts), so a delivery needing a few retries lands past a
  // 60s window. Give local generous headroom; real Iris (fast finality) is ~seconds–minutes.
  const deliveryTimeoutMs = local ? 180_000 : 600_000;

  const shieldAmount = ethers.parseUnits('10', 6);
  const unshieldAmount = ethers.parseUnits('5', 6);
  // CCTP V2 FAST transfers charge a fee (Circle's fee API returns a 1 bps minimum for Sepolia→Base).
  // The hub pool's defaultFinalityThreshold is FAST (1000) and atomicCrossChainUnshield has no
  // finality override, so on real CCTP maxFee=0 → Iris "insufficient_fee" → the burn stalls waiting
  // for hard finality (~15-19 min) instead of fast. Cover the fast fee with margin (10 bps ≥ the
  // 1 bps minimum); Circle deducts only the ACTUAL fee (≤ maxFee), and waitForClientDelivery already
  // subtracts maxFee from the expected delivery. Local mock CCTP charges nothing, so 0 there.
  const maxFee = local ? 0n : (unshieldAmount * 10n) / 10_000n;

  const signers = await ethers.getSigners();
  const deployer = signers[0];
  const deployerAddr = await deployer.getAddress();
  // finalRecipient receives USDC on the CLIENT chain. The deployer EOA exists on every chain.
  const finalRecipient = deployerAddr;

  // Hub contracts (hardhat network = hub).
  const privacyPool = await ethers.getContractAt('PrivacyPool', hubDeployment.contracts.privacyPool);
  const hubUsdc = await ethers.getContractAt('MockUSDCV2', hubDeployment.cctp.usdc);
  const hubUsdcAddress = await hubUsdc.getAddress();

  // Client chain USDC (read-only) for polling delivery — separate provider on the client RPC.
  const clientProvider = new ethers.JsonRpcProvider(local ? getRpcUrl(getChainById(clientDeployment.chainId)!) : config.clients[0].rpc);
  const clientUsdc = new ethers.Contract(clientDeployment.cctp.usdc, ERC20_BALANCE_ABI, clientProvider);

  // Verify SNARK mode + a few vkeys on the hub.
  console.log('\nVerifying on-chain verification keys...');
  for (const [n, m] of [[1, 1], [1, 2], [2, 2]]) {
    const vkey = await privacyPool.getVerificationKey(n, m);
    if (vkey.alpha1.x === 0n) throw new Error(`VK not set for ${n}x${m}`);
    console.log(`  ✓ ${n}x${m} vkey registered`);
  }
  const testingMode = await privacyPool.testingMode();
  console.log(`  Testing mode: ${testingMode} (should be false)`);
  if (testingMode) throw new Error('Testing mode is ON — proofs are not verified!');

  // Engine + prover.
  console.log('\nInitializing engine with Armada circuits...');
  clearDatabase();
  await initializeEngine('e2exchain');
  const chain: Chain = local
    ? getChainById(hubDeployment.chainId)!
    : { type: ChainType.EVM, id: hubDeployment.chainId };
  const rpcUrl = local ? getRpcUrl(chain) : config.hub.rpc;
  await loadNetworkIntoEngine(chain, await privacyPool.getAddress(), ethers.ZeroAddress, rpcUrl, hubDeployment.deployBlock ?? 0);
  await initializeProver();

  const aliceWalletInfo = await createWallet(DEFAULT_ENCRYPTION_KEY);
  const aliceWallet = getEngine().wallets[aliceWalletInfo.id] as unknown as RailgunWallet;
  console.log(`Alice (shielded): ${aliceWalletInfo.railgunAddress}`);
  console.log(`Final recipient (client chain, public): ${finalRecipient}`);

  // ═══════════════════════════════════════════════════════════
  // STEP 1: SHIELD on the hub
  // ═══════════════════════════════════════════════════════════
  console.log('\n' + '─'.repeat(40));
  console.log(`  STEP 1: SHIELD ${ethers.formatUnits(shieldAmount, 6)} USDC (hub)`);
  console.log('─'.repeat(40));

  const shieldPrivateKey = generateShieldPrivateKey();
  const { shieldRequest } = await createShieldRequest(
    { railgunAddress: aliceWalletInfo.railgunAddress, amount: shieldAmount, tokenAddress: hubUsdcAddress },
    shieldPrivateKey,
  );

  if (local) {
    await (await hubUsdc.mint(deployerAddr, shieldAmount)).wait();
  } else {
    const bal = await hubUsdc.balanceOf(deployerAddr);
    if (bal < shieldAmount) {
      throw new Error(
        `Deployer ${deployerAddr} holds ${ethers.formatUnits(bal, 6)} USDC on the hub but needs ` +
        `${ethers.formatUnits(shieldAmount, 6)}. Fund it from https://faucet.circle.com/ (Ethereum Sepolia).`,
      );
    }
  }
  await (await hubUsdc.connect(deployer).approve(await privacyPool.getAddress(), shieldAmount, overrides)).wait();
  const shieldTx = await privacyPool.connect(deployer).shield([shieldRequest], ethers.ZeroAddress, overrides);
  const shieldReceipt = await shieldTx.wait();
  console.log(`✓ Shield tx: ${shieldReceipt!.hash}`);

  await waitForBalance(aliceWalletInfo.id, chain, aliceWallet, hubUsdcAddress, shieldAmount - ethers.parseUnits('1', 6), 'shield', scanTimeoutMs);
  console.log(`✓ Shielded balance confirmed`);

  // ═══════════════════════════════════════════════════════════
  // STEP 2: CROSS-CHAIN UNSHIELD (hub burn, proof-bound destination)
  // ═══════════════════════════════════════════════════════════
  console.log('\n' + '─'.repeat(40));
  console.log(`  STEP 2: CROSS-CHAIN UNSHIELD ${ethers.formatUnits(unshieldAmount, 6)} USDC → client domain ${destinationDomain}`);
  console.log('─'.repeat(40));

  const recipientBaseline: bigint = await clientUsdc.balanceOf(finalRecipient);
  console.log(`  Recipient client-chain USDC before: ${ethers.formatUnits(recipientBaseline, 6)}`);

  const uniqueNonce = ethers.hexlify(ethers.randomBytes(32));
  const { transaction, transactions } = await buildXchainUnshieldTransaction({
    wallet: aliceWallet,
    chain,
    tokenAddress: hubUsdcAddress,
    privacyPoolAddress: await privacyPool.getAddress(),
    amount: unshieldAmount,
    finalRecipient,
    destinationDomain,
    maxFee,
    uniqueNonce,
    hubChainId: hubDeployment.chainId,
    progressCallback: () => process.stdout.write('.'),
  });
  console.log('');

  const unshieldTx = await deployer.sendTransaction({ to: transaction.to, data: transaction.data, ...overrides });
  const unshieldReceipt = await unshieldTx.wait();
  const proved = transactions[0];
  console.log(`✓ Cross-chain unshield tx: ${unshieldReceipt!.hash}`);
  console.log(`✓ Circuit shape: ${proved.nullifiers.length}x${proved.commitments.length}`);
  console.log(`✓ Proof verified on-chain (tx succeeded = Groth16 pairing + CCTP-binding check passed)`);

  // ═══════════════════════════════════════════════════════════
  // STEP 3: WAIT FOR CROSS-CHAIN DELIVERY (relayer + CCTP)
  // ═══════════════════════════════════════════════════════════
  console.log('\n' + '─'.repeat(40));
  console.log('  STEP 3: WAIT FOR CLIENT-CHAIN DELIVERY');
  console.log('─'.repeat(40));
  console.log(`  Waiting for the relayer to deliver via CCTP (timeout ${deliveryTimeoutMs / 1000}s)…`);

  const relayerHint = local ? 'npm run armada-relayer' : 'npm run relayer:sepolia';
  const finalBalance = await waitForClientDelivery(clientUsdc, finalRecipient, recipientBaseline, unshieldAmount - maxFee, deliveryTimeoutMs, relayerHint);
  const delivered = finalBalance - recipientBaseline;
  console.log(`✓ Delivered ${ethers.formatUnits(delivered, 6)} USDC to ${finalRecipient} on the client chain`);

  // ═══════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(60));
  console.log('  CROSS-CHAIN UNSHIELD VERIFICATION PASSED');
  console.log('='.repeat(60));
  console.log(`  ✓ Shield:   ${ethers.formatUnits(shieldAmount, 6)} USDC shielded on hub`);
  console.log(`  ✓ Unshield: ${ethers.formatUnits(unshieldAmount, 6)} USDC cross-chain (proof binds CCTP destination, #364/#399)`);
  console.log(`  ✓ Delivery: ${ethers.formatUnits(delivered, 6)} USDC arrived at the recipient on client domain ${destinationDomain}`);
  console.log('  ✓ Proof verified on-chain via Groth16 pairing + destination-binding check');

  await shutdownEngine();
}

main().then(() => {
  process.exit(0);
}).catch(async (err) => {
  console.error('\n❌ Cross-chain unshield e2e failed:', err);
  try { await shutdownEngine(); } catch { /* ignore */ }
  process.exit(1);
});
