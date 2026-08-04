// ABOUTME: Phase 0 Spike 2 — claim-as-transfer. Funds an ephemeral wallet's note, spends it to a
// ABOUTME: recipient with a broadcaster fee note, and verifies the §6 claim-payment safety properties.
//
// Throwaway spike (armada-sdk Phase 0, ARMADA_SDK.md §6 / handoff Step 3). Verifies:
//   1. recipient's EVM (0x) address is ABSENT from the transfer calldata (privacy),
//   2. the broadcaster fee note is verified by the RELAYER's exact primitive
//      (extractFirstNoteERC20AmountMap — the same check broadcaster-fee-verifier.ts runs), and
//   3. nullifier race — a second competing spend of the same note reverts ("first spend wins").
//
// The fee note is addressed to the relayer's 0zk (derived from RELAYER_RAILGUN_MNEMONIC), exactly as
// a real claim transfer would carry it. Submission is direct on-chain here; the live /relay HTTP
// round-trip is the same fee mechanism, already exercised in-stack by the interface.
//
// Run:  source config/local.env && npx hardhat run scripts/capture/spike-claim-as-transfer.ts --network hub

import { ethers } from 'hardhat';

import {
  TXIDVersion,
  RailgunWallet,
  POI,
  POINodeInterface,
} from '@railgun-community/engine';

import { initializeEngine, shutdownEngine, clearDatabase, getEngine } from '../../lib/sdk/init';
import { DEFAULT_ENCRYPTION_KEY } from '../../lib/sdk/wallet';
import {
  initializeProver,
  createTransactionBatch,
  addTransferOutput,
  generateProvedTransactions,
  generateTransactCall,
} from '../../lib/sdk/prover';
import { createShieldRequest, generateShieldPrivateKey } from '../../lib/sdk/shield';
import { loadNetworkIntoEngine, scanWalletBalances } from '../../lib/sdk/network';
import { getChainById, getRpcUrl } from '../../lib/sdk/chain-config';
import { loadVerificationKeys, TESTING_ARTIFACT_CONFIGS } from '../../lib/artifacts';

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

const deployments = require('../../deployments/privacy-pool-hub.json');
// Anvil default mnemonic — matches config/local.env RELAYER_RAILGUN_MNEMONIC, so this derives the
// same 0zk the real relayer uses as its broadcaster-fee recipient.
const RELAYER_MNEMONIC = 'test test test test test test test test test test test junk';

// Fixed BIP-39 mnemonics for the spike's roles (distinct, deterministic).
const EPHEMERAL_MNEMONIC = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const RECIPIENT_MNEMONIC = 'letter advice cage absurd amount doctor acoustic avoid letter advice cage above';
const SENDER_MNEMONIC = 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong';

let pass = 0, fail = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? '✓ PASS' : '✗ FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
  ok ? pass++ : fail++;
}

async function makeWallet(mnemonic: string): Promise<RailgunWallet> {
  const info = await getEngine().createWalletFromMnemonic(DEFAULT_ENCRYPTION_KEY, mnemonic, 0, undefined);
  return getEngine().wallets[info.id] as RailgunWallet;
}

// Build a claim transfer of the ephemeral wallet's whole note: `toRecipient` to `recipient0zk`
// plus `feeAmount` to `relayer0zk`. Returns the proved calldata (does not submit).
async function buildClaimTransfer(
  ephemeral: RailgunWallet, chain: any, usdc: string,
  recipient0zk: string, toRecipient: bigint, relayer0zk: string, feeAmount: bigint,
) {
  const batch = createTransactionBatch(chain);
  // Broadcaster fee note FIRST — the relayer verifies the FIRST decryptable note
  // (extractFirstNoteERC20AmountMap), matching how the transact broadcaster-fee output is placed.
  addTransferOutput(batch, relayer0zk, feeAmount, usdc, false);          // broadcaster fee note
  addTransferOutput(batch, recipient0zk, toRecipient, usdc, false);      // claim output
  const transactions = await generateProvedTransactions(batch, ephemeral, TXIDVersion.V2_PoseidonMerkle, DEFAULT_ENCRYPTION_KEY);
  const contractTransaction = await generateTransactCall(TXIDVersion.V2_PoseidonMerkle, transactions, chain);
  return { transactions, contractTransaction };
}

async function main() {
  console.log('='.repeat(64));
  console.log('  Phase 0 Spike 2 — claim-as-transfer (engine 9.6.0)');
  console.log('='.repeat(64));

  const [deployer, funder] = await ethers.getSigners();
  // A distinct Anvil EOA standing in for the recipient's PUBLIC address — we assert it never
  // appears in the transfer calldata.
  const recipientEoa = (await ethers.getSigners())[6];
  const recipientEoaAddr = await recipientEoa.getAddress();

  const privacyPool = await ethers.getContractAt('PrivacyPool', deployments.contracts.privacyPool);
  const usdc = await ethers.getContractAt('MockUSDCV2', deployments.cctp.usdc);
  const usdcAddress = await usdc.getAddress();

  await loadVerificationKeys(privacyPool, TESTING_ARTIFACT_CONFIGS, true);
  clearDatabase();
  await initializeEngine('spike2');
  const chain = getChainById(deployments.chainId)!;
  await loadNetworkIntoEngine(chain, await privacyPool.getAddress(), ethers.ZeroAddress, getRpcUrl(chain), deployments.deployBlock ?? 0);
  await initializeProver();

  console.log('\nWallets:');
  const ephemeral = await makeWallet(EPHEMERAL_MNEMONIC);
  const recipient = await makeWallet(RECIPIENT_MNEMONIC);
  const sender = await makeWallet(SENDER_MNEMONIC);
  const relayer = await makeWallet(RELAYER_MNEMONIC);
  const ephemeralInfo = ephemeral.id, recipientInfo = recipient.id;
  console.log('  ephemeral:', ephemeral.getAddress().slice(0, 24) + '…');
  console.log('  recipient:', recipient.getAddress().slice(0, 24) + '…', `(public EOA ${recipientEoaAddr.slice(0, 10)}…)`);
  console.log('  relayer  :', relayer.getAddress().slice(0, 24) + '…');

  // ── Fund the ephemeral wallet's note (the "cheque") ──
  const noteValue = ethers.parseUnits('100', 6);
  console.log('\nFunding ephemeral wallet with a 100 USDC shielded note…');
  const { shieldRequest } = await createShieldRequest({ railgunAddress: ephemeral.getAddress(), amount: noteValue, tokenAddress: usdcAddress }, generateShieldPrivateKey());
  await (await usdc.mint(await funder.getAddress(), noteValue)).wait();
  await (await usdc.connect(funder).approve(await privacyPool.getAddress(), noteValue)).wait();
  await (await privacyPool.connect(funder).shield([shieldRequest], ethers.ZeroAddress)).wait();
  await scanWalletBalances(ephemeralInfo, chain);
  await new Promise(r => setTimeout(r, 2000));
  const ephTxos = await ephemeral.TXOs(TXIDVersion.V2_PoseidonMerkle, chain);
  const notedValue = ephTxos[0]?.note.value ?? 0n; // < 100 after the 50 bps shield fee
  check('ephemeral wallet holds the funded note', ephTxos.length === 1 && notedValue > 0n, `${ethers.formatUnits(notedValue, 6)} USDC (after shield fee)`);

  const feeAmount = ethers.parseUnits('1', 6);
  const toRecipient = notedValue - feeAmount; // exact spend: recipient output + relayer fee = note value

  // ── Build the CLAIM transfer and a competing RECLAIM (same note), both before submitting ──
  console.log('\nBuilding claim transfer (ephemeral → recipient + relayer fee)…');
  const claim = await buildClaimTransfer(ephemeral, chain, usdcAddress, recipient.getAddress(), toRecipient, relayer.getAddress(), feeAmount);
  console.log('Building competing reclaim transfer (ephemeral → sender, same note)…');
  const reclaim = await buildClaimTransfer(ephemeral, chain, usdcAddress, sender.getAddress(), toRecipient, relayer.getAddress(), feeAmount);

  // ── Property 1: recipient's public 0x address absent from calldata ──
  console.log('\n── Property 1: recipient EVM address absent from calldata ──');
  const calldata = claim.contractTransaction.data as string;
  const recipientHexBody = recipientEoaAddr.toLowerCase().replace(/^0x/, '');
  check('recipient EOA not present in transfer calldata', !calldata.toLowerCase().includes(recipientHexBody), `to=${(claim.contractTransaction.to as string).slice(0, 10)}… (PrivacyPool)`);

  // ── Property 2: broadcaster fee verified via the relayer's own primitive ──
  console.log('\n── Property 2: broadcaster fee verified (relayer primitive) ──');
  const feeMap = await relayer.extractFirstNoteERC20AmountMap(
    TXIDVersion.V2_PoseidonMerkle, chain,
    { to: claim.contractTransaction.to, data: claim.contractTransaction.data } as any,
    false, await privacyPool.getAddress());
  const paidToRelayer = feeMap[usdcAddress.toLowerCase()] ?? 0n;
  check('fee note decrypts to relayer 0zk with value ≥ advertised fee', paidToRelayer >= feeAmount, `paid ${ethers.formatUnits(paidToRelayer, 6)} ≥ ${ethers.formatUnits(feeAmount, 6)} USDC`);

  // ── Submit the claim on-chain ──
  console.log('\nSubmitting claim transfer…');
  await (await funder.sendTransaction({ to: claim.contractTransaction.to, data: claim.contractTransaction.data })).wait();
  await scanWalletBalances(recipientInfo, chain);
  await scanWalletBalances(ephemeralInfo, chain);
  await new Promise(r => setTimeout(r, 2000));
  const recipientTxos = await recipient.TXOs(TXIDVersion.V2_PoseidonMerkle, chain);
  const recipientBalance = recipientTxos.filter(t => t.spendtxid === false).reduce((s, t) => s + t.note.value, 0n);
  check('recipient received the claimed note', recipientBalance === toRecipient, `${ethers.formatUnits(recipientBalance, 6)} USDC`);
  const ephAfter = await ephemeral.TXOs(TXIDVersion.V2_PoseidonMerkle, chain);
  check('ephemeral note is now spent (nullifier consumed)', ephAfter.every(t => t.spendtxid !== false));

  // ── Property 3: nullifier race — the competing reclaim must revert ──
  console.log('\n── Property 3: nullifier race (reclaim after claim) ──');
  let reverted = false;
  try {
    await (await funder.sendTransaction({ to: reclaim.contractTransaction.to, data: reclaim.contractTransaction.data })).wait();
  } catch {
    reverted = true;
  }
  check('competing reclaim of the same note reverts (first spend wins)', reverted);

  console.log('\n' + '='.repeat(64));
  console.log(`  Spike 2 result: ${pass} passed, ${fail} failed`);
  console.log('='.repeat(64));
  await shutdownEngine();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('\nSpike 2 failed:', err);
  try { await shutdownEngine(); } catch { /* ignore */ }
  process.exit(1);
});
