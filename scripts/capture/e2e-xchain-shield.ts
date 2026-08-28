// ABOUTME: End-to-end verification of cross-chain shield — burn USDC on the client chain via CCTP,
// ABOUTME: the relayer delivers to the hub, and the hub hook shields it into a real wallet's note.

/**
 * End-to-End: Cross-Chain Shield (client → hub, FAST finality)
 *
 * Flow:
 *   1. Build a genuine shield request for a hub-side shielded wallet (npk + ciphertext) so the
 *      shielded note is decryptable — unlike test_sepolia's smoke test, which uses synthetic values
 *      and never verifies a wallet actually receives the note.
 *   2. crossChainShield on the client PrivacyPoolClient: burns USDC via CCTP to the hub with FAST
 *      finality + a maxFee (FAST charges a fee — maxFee=0 stalls at hard finality).
 *   3. The relayer picks up the client MessageSent, gets the Iris attestation, and delivers to the
 *      hub CCTPHookRouter → the hub PrivacyPool shields the USDC to the note. We scan the hub wallet
 *      until the shielded balance appears.
 *
 * WHY FAST specifically: the interface shields cross-chain at FAST on sepolia, and FAST transfers
 * have Circle fill feeExecuted + expirationBlock during attestation. A relayer bug rejected those as
 * tampered (dead-letter) until the iris-relay message-match whitelist was widened — this is the only
 * automated regression guard for that path (the unshield e2e covers the other CCTP direction).
 *
 * REQUIRES A RUNNING RELAYER (it completes the hub side):
 *   local   : npm run armada-relayer          (CCTP_MODE=mock)
 *   sepolia : npm run relayer:sepolia         (CCTP_MODE=real, Iris attestation)
 *
 * Prerequisites (local):
 *   npm run chains ; source config/local.env && npm run setup ; npm run armada-relayer
 *   npx hardhat run scripts/capture/e2e-xchain-shield.ts --network hub
 *
 * Prerequisites (sepolia): deployer pre-funded with ~5 USDC + ETH on Base Sepolia (the client); relayer up.
 *   source config/sepolia.env
 *   npx hardhat run scripts/capture/e2e-xchain-shield.ts --network sepoliaHub
 */

import { ethers } from 'hardhat';

import { initializeEngine, shutdownEngine, clearDatabase, getEngine } from '../../lib/sdk/init';
import { createWallet, DEFAULT_ENCRYPTION_KEY } from '../../lib/sdk/wallet';
import { createShieldRequest, generateShieldPrivateKey } from '../../lib/sdk/shield';
import { loadNetworkIntoEngine, scanWalletBalances } from '../../lib/sdk/network';
import { getSpendableBalance } from '../../lib/sdk/transfer';
import { getChainById, getRpcUrl } from '../../lib/sdk/chain-config';
import { getNetworkConfig, isLocal } from '../../config/networks';
import { loadDeployment } from '../deploy-utils';

import { POI, POINodeInterface, RailgunWallet } from '@railgun-community/engine';
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

// MockUSDCV2 exposes mint(); real USDC does not — mint() is only called on local.
const CLIENT_USDC_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function mint(address to, uint256 amount)',
];
const CLIENT_POOL_ABI = [
  'function crossChainShield(uint256 amount, uint256 maxFee, uint32 minFinalityThreshold, bytes32 npk, bytes32[3] encryptedBundle, bytes32 shieldKey, address integrator) external returns (uint64)',
];

/** CCTPFinality.FAST — matches contracts/cctp/ICCTPV2.sol. The interface uses FAST on sepolia. */
const FINALITY_FAST = 1000;

/** Poll the SDK merkletree scan until the wallet's spendable balance reaches at least `minAmount`. */
async function waitForShieldedBalance(
  walletId: string, chain: Chain, wallet: RailgunWallet, tokenAddress: string, minAmount: bigint, timeoutMs: number, relayerHint: string,
): Promise<bigint> {
  const start = Date.now();
  let attempt = 0;
  while (Date.now() - start < timeoutMs) {
    await scanWalletBalances(walletId, chain);
    const bal = await getSpendableBalance(wallet, chain, tokenAddress);
    if (bal >= minAmount) return bal;
    attempt += 1;
    const elapsed = Math.round((Date.now() - start) / 1000);
    console.log(`  (scan ${attempt}, ${elapsed}s: shielded ${ethers.formatUnits(bal, 6)} / ${ethers.formatUnits(minAmount, 6)} USDC — waiting for relayer + CCTP + hub shield…)`);
    await new Promise(r => setTimeout(r, 6000));
  }
  throw new Error(
    `Hub shielded balance didn't reach ${ethers.formatUnits(minAmount, 6)} within ${timeoutMs / 1000}s. ` +
    `Is the relayer running (${relayerHint})? Check its logs for the CCTP relay of the client burn.`,
  );
}

async function main() {
  console.log('='.repeat(60));
  console.log('  End-to-End: Cross-Chain Shield (client → hub, FAST)');
  console.log('='.repeat(60));

  const config = getNetworkConfig();
  const local = isLocal();
  const suffix = local ? '' : `-${config.env}`;

  const hubDeployment = loadDeployment(`privacy-pool-hub${suffix}.json`);
  if (!hubDeployment) throw new Error(`privacy-pool-hub${suffix}.json not found — deploy first`);
  const clientDeployment = loadDeployment(`privacy-pool-client${suffix}.json`);
  if (!clientDeployment) throw new Error(`privacy-pool-client${suffix}.json not found — deploy the client chain first`);

  console.log(`\nClient A (chainId ${clientDeployment.chainId}, CCTP domain ${config.clients[0].cctpDomain}) → Hub: ${config.env} (chainId ${hubDeployment.chainId})`);
  console.log(`Relayer required: ${local ? 'npm run armada-relayer (mock CCTP)' : 'npm run relayer:sepolia (real CCTP)'}`);

  const shieldAmount = ethers.parseUnits('5', 6);
  // CCTP V2 FAST charges a fee (Circle's fee API returns a 1 bps minimum). maxFee=0 → Iris
  // "insufficient_fee" → the burn stalls at hard finality. Cover it with margin (10 bps ≥ the 1 bps
  // minimum); Circle deducts only the actual fee. Local mock CCTP charges nothing, so 0 there.
  const maxFee = local ? 0n : (shieldAmount * 10n) / 10_000n;
  const clientOverrides = local ? {} : { gasLimit: 500_000n };
  // The shielded balance only appears after the full client→hub delivery (relayer + CCTP + hub shield),
  // so this window must cover the whole path, not just a local scan.
  const deliveryTimeoutMs = local ? 180_000 : 600_000;

  // Hub contracts (hardhat network = hub) — for the vkey/testingMode sanity checks + engine load.
  const privacyPool = await ethers.getContractAt('PrivacyPool', hubDeployment.contracts.privacyPool);
  const hubUsdcAddress: string = hubDeployment.cctp.usdc;

  // Client chain: separate provider + signer (the burn happens here, NOT on the hardhat network).
  const clientProvider = new ethers.JsonRpcProvider(local ? getRpcUrl(getChainById(clientDeployment.chainId)!) : config.clients[0].rpc);
  const clientSigner = new ethers.Wallet(config.deployerPrivateKey, clientProvider);
  const clientUsdc = new ethers.Contract(clientDeployment.cctp.usdc, CLIENT_USDC_ABI, clientSigner);
  const clientPoolAddress: string = clientDeployment.contracts.privacyPoolClient;
  const clientPool = new ethers.Contract(clientPoolAddress, CLIENT_POOL_ABI, clientSigner);

  // Sanity: SNARK mode + a vkey on the hub (the hub still verifies inserted commitments).
  const testingMode = await privacyPool.testingMode();
  console.log(`\nHub testingMode: ${testingMode} (should be false)`);
  if (testingMode) throw new Error('Testing mode is ON — proofs are not verified!');

  // Engine — the wallet scans the HUB for its incoming shielded note. No prover needed (shield has no proof).
  console.log('\nInitializing engine…');
  clearDatabase();
  await initializeEngine('e2exchainshield');
  const chain: Chain = local
    ? getChainById(hubDeployment.chainId)!
    : { type: ChainType.EVM, id: hubDeployment.chainId };
  const hubRpc = local ? getRpcUrl(chain) : config.hub.rpc;
  await loadNetworkIntoEngine(chain, await privacyPool.getAddress(), ethers.ZeroAddress, hubRpc, hubDeployment.deployBlock ?? 0);

  const aliceWalletInfo = await createWallet(DEFAULT_ENCRYPTION_KEY);
  const aliceWallet = getEngine().wallets[aliceWalletInfo.id] as unknown as RailgunWallet;
  console.log(`Alice (hub shielded recipient): ${aliceWalletInfo.railgunAddress}`);

  // A genuine shield request for Alice's hub note. The note is denominated in HUB USDC — CCTP mints
  // USDC on the hub and the hook shields THAT. npk/ciphertext are what crossChainShield forwards.
  const shieldPrivateKey = generateShieldPrivateKey();
  const { shieldRequest } = await createShieldRequest(
    { railgunAddress: aliceWalletInfo.railgunAddress, amount: shieldAmount, tokenAddress: hubUsdcAddress },
    shieldPrivateKey,
  );
  const npk: string = shieldRequest.preimage.npk;
  const encryptedBundle = shieldRequest.ciphertext.encryptedBundle as [string, string, string];
  const shieldKey: string = shieldRequest.ciphertext.shieldKey;

  // ═══════════════════════════════════════════════════════════
  // STEP 1: CROSS-CHAIN SHIELD (burn on the client)
  // ═══════════════════════════════════════════════════════════
  console.log('\n' + '─'.repeat(40));
  console.log(`  STEP 1: CROSS-CHAIN SHIELD ${ethers.formatUnits(shieldAmount, 6)} USDC (client → hub, FAST)`);
  console.log('─'.repeat(40));

  const clientAddr = clientSigner.address;
  if (local) {
    await (await clientUsdc.mint(clientAddr, shieldAmount)).wait();
  } else {
    const bal: bigint = await clientUsdc.balanceOf(clientAddr);
    if (bal < shieldAmount) {
      throw new Error(
        `Deployer ${clientAddr} holds ${ethers.formatUnits(bal, 6)} USDC on the client but needs ` +
        `${ethers.formatUnits(shieldAmount, 6)}. Fund it from https://faucet.circle.com/ (Base Sepolia).`,
      );
    }
  }

  const clientBalBefore: bigint = await clientUsdc.balanceOf(clientAddr);
  await (await clientUsdc.approve(clientPoolAddress, shieldAmount, clientOverrides)).wait();
  const shieldTx = await clientPool.crossChainShield(
    shieldAmount, maxFee, FINALITY_FAST, npk, encryptedBundle, shieldKey, ethers.ZeroAddress, clientOverrides,
  );
  const shieldReceipt = await shieldTx.wait();
  console.log(`✓ crossChainShield tx (client): ${shieldReceipt!.hash}`);

  const clientBalAfter: bigint = await clientUsdc.balanceOf(clientAddr);
  const burned = clientBalBefore - clientBalAfter;
  if (burned !== shieldAmount) {
    throw new Error(`Expected to burn ${ethers.formatUnits(shieldAmount, 6)} USDC on the client, burned ${ethers.formatUnits(burned, 6)}`);
  }
  console.log(`✓ Burned ${ethers.formatUnits(burned, 6)} USDC on the client chain`);

  // ═══════════════════════════════════════════════════════════
  // STEP 2: WAIT FOR THE HUB SHIELD (relayer + CCTP + hook)
  // ═══════════════════════════════════════════════════════════
  console.log('\n' + '─'.repeat(40));
  console.log('  STEP 2: WAIT FOR HUB SHIELD DELIVERY');
  console.log('─'.repeat(40));
  console.log(`  Waiting for the relayer to deliver + the hub to shield (timeout ${deliveryTimeoutMs / 1000}s)…`);

  const relayerHint = local ? 'npm run armada-relayer' : 'npm run relayer:sepolia';
  // The wallet receives shieldAmount minus the CCTP fast fee and the hub shield fee — require 90% to
  // confirm the bulk arrived without pinning the exact fee schedule.
  const minShielded = (shieldAmount * 9n) / 10n;
  const shielded = await waitForShieldedBalance(aliceWalletInfo.id, chain, aliceWallet, hubUsdcAddress, minShielded, deliveryTimeoutMs, relayerHint);
  console.log(`✓ Hub shielded balance: ${ethers.formatUnits(shielded, 6)} USDC`);

  // ═══════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(60));
  console.log('  CROSS-CHAIN SHIELD VERIFICATION PASSED');
  console.log('='.repeat(60));
  console.log(`  ✓ Burn:    ${ethers.formatUnits(shieldAmount, 6)} USDC burned on the client (FAST, maxFee ${ethers.formatUnits(maxFee, 6)})`);
  console.log(`  ✓ Deliver: relayer + CCTP delivered to the hub`);
  console.log(`  ✓ Shield:  ${ethers.formatUnits(shielded, 6)} USDC shielded into the hub wallet's note`);

  await shutdownEngine();
}

main().then(() => {
  process.exit(0);
}).catch(async (err) => {
  console.error('\n❌ Cross-chain shield e2e failed:', err);
  try { await shutdownEngine(); } catch { /* ignore */ }
  process.exit(1);
});
