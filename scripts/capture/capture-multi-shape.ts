/**
 * Capture reference proof vectors for multiple circuit shapes.
 *
 * This script captures 2x2 transfer and 1x1 exact-spend vectors.
 * Each shape is captured from a clean state (fresh engine init + wallets).
 *
 * Prerequisites:
 *   cd /Users/andrewburger/armada/armada-poc
 *   npm run chains          # terminal 1 — start Anvil
 *   source config/local.env && npm run setup  # terminal 2 — deploy
 *   npx hardhat run scripts/capture/capture-multi-shape.ts --network hub
 *
 * Output: ../../../armada-circuits/tests/fixtures/generated/
 */

import * as fs from 'fs';
import * as path from 'path';
import { ethers } from 'hardhat';

import { initializeEngine, shutdownEngine, clearDatabase, getEngine } from '../../lib/sdk/init';
import { createWallet, DEFAULT_ENCRYPTION_KEY } from '../../lib/sdk/wallet';
import { initializeProver } from '../../lib/sdk/prover';
import { createShieldRequest, generateShieldPrivateKey, calculateNpk } from '../../lib/sdk/shield';
import { loadNetworkIntoEngine, scanWalletBalances, getMerkleRoot, getMerkleProof } from '../../lib/sdk/network';
import { createPrivateTransfer, createUnshield } from '../../lib/sdk/transfer';
import { getChainById, getRpcUrl } from '../../lib/sdk/chain-config';
import { loadVerificationKeys, TESTING_ARTIFACT_CONFIGS } from '../../lib/artifacts';

import { TXIDVersion, getTokenDataERC20, getTokenDataHash, POI, POINodeInterface } from '@railgun-community/engine';

// ── POI Stub (same as original) ────────────────────────────
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

// ── Constants ──────────────────────────────────────────────
const deployments = require('../../deployments/privacy-pool-hub.json');
const SNARK_SCALAR_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const FIXTURES_DIR = path.join(__dirname, '..', '..', '..', 'armada-circuits', 'tests', 'fixtures', 'generated');

// ── Types ──────────────────────────────────────────────────
interface TransferVector {
  operation: 'transfer';
  shape: { nullifiers: number; commitments: number };
  chainId: number;
  inputs: Array<{
    notePublicKey: string;
    tokenHash: string;
    tokenAddress: string;
    value: string;
    random: string;
    treeNumber: number;
    leafIndex: number;
    nullifier: string;
    merkleProof: { leaf: string; elements: string[]; indices: string; root: string; };
  }>;
  keys: { nullifyingKey: string; spendingPublicKey: [string, string]; };
  eddsaSignature: { R8: [string, string]; S: string; };
  outputs: Array<{
    notePublicKey: string;
    tokenAddress: string;
    tokenHash: string;
    value: string;
    random: string;
    recipientAddress: string;
  }>;
  transactionStruct: any;
  publicSignals: string[];
  boundParamsHash: string;
  txHash: string;
  metadata: {
    tokenAddress: string;
    transferAmount: string;
    senderAddress: string;
    recipientAddress: string;
  };
}

// ── Helpers ────────────────────────────────────────────────
function toHex(n: bigint | string): string {
  if (typeof n === 'string') return n;
  return '0x' + n.toString(16).padStart(64, '0');
}

function bigintReplacer(_key: string, value: any): any {
  return typeof value === 'bigint' ? toHex(value) : value;
}

function writeJSON(filePath: string, obj: any): void {
  fs.writeFileSync(filePath, JSON.stringify(obj, bigintReplacer, 2));
}

function computeBoundParamsHash(boundParams: any): string {
  const ccArray = boundParams.commitmentCiphertext.map((cc: any) => [
    cc.ciphertext, cc.blindedSenderViewingKey, cc.blindedReceiverViewingKey, cc.annotationData, cc.memo,
  ]);
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  const encoded = abiCoder.encode(
    ['tuple(uint16 treeNumber, uint72 minGasPrice, uint8 unshield, uint64 chainID, address adaptContract, bytes32 adaptParams, tuple(bytes32[4],bytes32,bytes32,bytes,bytes)[])'],
    [[Number(boundParams.treeNumber), BigInt(boundParams.minGasPrice ?? 0), Number(boundParams.unshield ?? 0),
      BigInt(boundParams.chainID), boundParams.adaptContract, boundParams.adaptParams, ccArray]]
  );
  return toHex(BigInt(ethers.keccak256(encoded)) % SNARK_SCALAR_FIELD);
}

function buildPublicInputs(tx: any): string[] {
  return [
    toHex(BigInt(tx.merkleRoot)),
    computeBoundParamsHash(tx.boundParams),
    ...tx.nullifiers.map((n: any) => toHex(BigInt(n))),
    ...tx.commitments.map((c: any) => toHex(BigInt(c))),
  ];
}

function serializeProof(proof: any): any {
  return JSON.parse(JSON.stringify(proof, (_, v) => typeof v === 'bigint' ? toHex(v) : v));
}

// ── Core: capture a single transfer vector ─────────────────

interface ShapeConfig {
  name: string;
  description: string;
  // Shield amounts to set up the UTXO set for Alice
  shieldAmounts: bigint[];
  // Amount to transfer or unshield
  amount: bigint;
  // Operation type
  operation: 'transfer' | 'unshield';
}

async function captureShape(
  config: ShapeConfig,
  aliceSigner: any,
  bobSigner: any,
  privacyPool: any,
  usdc: any,
  usdcAddress: string,
  chain: any,
): Promise<void> {
  const { name, description, shieldAmounts, amount, operation } = config;

  console.log('\n' + '='.repeat(60));
  console.log(`  Capturing: ${name} — ${description}`);
  console.log('='.repeat(60));

  // Re-init engine for clean state
  console.log('Reinitializing engine...');
  try { await shutdownEngine(); } catch { /* ignore */ }
  clearDatabase();
  await initializeEngine('capture');

  await loadNetworkIntoEngine(
    chain,
    await privacyPool.getAddress(),
    ethers.ZeroAddress,
    getRpcUrl(chain),
    deployments.deployBlock ?? 0,
  );

  await initializeProver();

  // Create fresh wallets
  const aliceWalletInfo = await createWallet(DEFAULT_ENCRYPTION_KEY);
  const bobWalletInfo = await createWallet(DEFAULT_ENCRYPTION_KEY);
  const engine = getEngine();
  const aliceWallet = engine.wallets[aliceWalletInfo.id];
  const bobWallet = engine.wallets[bobWalletInfo.id];
  const aliceShieldedAddress = aliceWalletInfo.railgunAddress;
  const bobShieldedAddress = bobWalletInfo.railgunAddress;

  console.log('Alice:', aliceShieldedAddress);
  console.log('Bob:', bobShieldedAddress);

  // ── Shield to create UTXOs ───────────────────────────────
  for (let i = 0; i < shieldAmounts.length; i++) {
    const amt = shieldAmounts[i];
    console.log(`\nShield #${i + 1}: ${ethers.formatUnits(amt, 6)} USDC`);

    const shieldPrivateKey = generateShieldPrivateKey();
    const { shieldRequest } = await createShieldRequest(
      { railgunAddress: aliceShieldedAddress, amount: amt, tokenAddress: usdcAddress },
      shieldPrivateKey,
    );

    // Mint + approve + shield
    await (await usdc.mint(await aliceSigner.getAddress(), amt)).wait();
    await (await usdc.connect(aliceSigner).approve(await privacyPool.getAddress(), amt)).wait();
    const shieldTx = await privacyPool.connect(aliceSigner).shield([shieldRequest], ethers.ZeroAddress);
    await shieldTx.wait();

    // Wait for engine sync
    await scanWalletBalances(aliceWalletInfo.id, chain);
    await new Promise(r => setTimeout(r, 2000));
  }

  // Verify UTXO count
  const aliceTxos = await aliceWallet.TXOs(TXIDVersion.V2_PoseidonMerkle, chain);
  console.log(`\nAlice has ${aliceTxos.length} UTXO(s):`);
  for (const txo of aliceTxos) {
    console.log(`  tree=${txo.tree} pos=${txo.position} value=${ethers.formatUnits(txo.note.value, 6)} USDC spent=${txo.spendtxid !== false}`);
  }

  // ── Extract input witnesses BEFORE transfer ──────────────
  const inputWitnesses: TransferVector['inputs'] = [];
  for (const txo of aliceTxos) {
    if (txo.spendtxid !== false) continue; // skip spent
    const merkleProof = await getMerkleProof(chain, txo.tree, txo.position);
    if (!merkleProof) throw new Error(`Failed to get Merkle proof`);

    inputWitnesses.push({
      notePublicKey: toHex(txo.note.notePublicKey),
      tokenHash: txo.note.tokenHash,
      tokenAddress: txo.note.tokenData.tokenAddress,
      value: txo.note.value.toString(),
      random: txo.note.random,
      treeNumber: txo.tree,
      leafIndex: txo.position,
      nullifier: txo.nullifier,
      merkleProof: { leaf: merkleProof.leaf, elements: merkleProof.elements, indices: merkleProof.indices, root: merkleProof.root },
    });
  }

  // ── Capture spending keys ────────────────────────────────
  const spendingKeyPair = await aliceWallet.getSpendingKeyPair(DEFAULT_ENCRYPTION_KEY);
  const nullifyingKey = aliceWallet.nullifyingKey;

  let provedTx: any;
  let txHash: string;

  // ── Execute transfer or unshield ────────────────────
  if (operation === 'unshield') {
    const bobAddress = await bobSigner.getAddress();
    console.log(`\nUnshielding ${ethers.formatUnits(amount, 6)} USDC to ${bobAddress}...`);

    const unshieldResult = await createUnshield({
      wallet: aliceWallet,
      chain,
      tokenAddress: usdcAddress,
      recipientAddress: bobAddress,
      amount,
      encryptionKey: DEFAULT_ENCRYPTION_KEY,
      progressCallback: (p: any) => console.log(`  [${Math.round(p.progress)}%] ${p.status}`),
    });

    // Submit on-chain
    const tx = await aliceSigner.sendTransaction({
      to: unshieldResult.contractTransaction.to,
      data: unshieldResult.contractTransaction.data,
    });
    const receipt = await tx.wait();
    txHash = receipt!.hash;
    console.log('Unshield tx:', txHash);

    provedTx = unshieldResult.transactions[0];
  } else {
    console.log(`\nTransferring ${ethers.formatUnits(amount, 6)} USDC to Bob...`);

    const transferResult = await createPrivateTransfer({
      wallet: aliceWallet,
      chain,
      tokenAddress: usdcAddress,
      recipientAddress: bobShieldedAddress,
      amount,
      encryptionKey: DEFAULT_ENCRYPTION_KEY,
      progressCallback: (p: any) => console.log(`  [${Math.round(p.progress)}%] ${p.status}`),
    });

    // Submit on-chain
    const tx = await aliceSigner.sendTransaction({
      to: transferResult.contractTransaction.to,
      data: transferResult.contractTransaction.data,
    });
    const receipt = await tx.wait();
    txHash = receipt!.hash;
    console.log('Transfer tx:', txHash);

    provedTx = transferResult.transactions[0];
  }
  const numNullifiers = provedTx.nullifiers.length;
  const numCommitments = provedTx.commitments.length;
  console.log(`Circuit shape: ${numNullifiers}x${numCommitments}`);

  // Verify shape matches expectation
  const expectedInputs = inputWitnesses.length;
  if (numNullifiers > expectedInputs) {
    console.warn(`Warning: circuit has ${numNullifiers} nullifiers but we captured ${expectedInputs} witnesses. ` +
      `The SDK may have padded inputs. Need to capture witnesses for all selected UTXOs.`);
  }

  // ── EdDSA signature ──────────────────────────────────────
  const publicInputsForSign = {
    merkleRoot: BigInt(provedTx.merkleRoot),
    boundParamsHash: BigInt(computeBoundParamsHash(provedTx.boundParams)),
    nullifiers: provedTx.nullifiers.map((n: any) => BigInt(n)),
    commitmentsOut: provedTx.commitments.map((c: any) => BigInt(c)),
  };
  const eddsaSig = await aliceWallet.sign(publicInputsForSign, DEFAULT_ENCRYPTION_KEY);

  // ── Public signals ───────────────────────────────────────
  const publicSignals = buildPublicInputs(provedTx);
  const boundParamsHash = computeBoundParamsHash(provedTx.boundParams);

  // ── Extract outputs ──────────────────────────────────────
  const outputs: TransferVector['outputs'] = [];

  // Scan Bob's wallet for received note(s)
  await scanWalletBalances(bobWalletInfo.id, chain);
  await new Promise(r => setTimeout(r, 2000));

  const bobTxos = await bobWallet.TXOs(TXIDVersion.V2_PoseidonMerkle, chain);
  console.log(`Bob has ${bobTxos.length} UTXO(s)`);
  for (const txo of bobTxos) {
    outputs.push({
      notePublicKey: toHex(txo.note.notePublicKey),
      tokenAddress: txo.note.tokenData.tokenAddress,
      tokenHash: txo.note.tokenHash,
      value: txo.note.value.toString(),
      random: txo.note.random,
      recipientAddress: bobShieldedAddress,
    });
  }

  // Scan Alice for change note
  await scanWalletBalances(aliceWalletInfo.id, chain);
  await new Promise(r => setTimeout(r, 2000));

  const aliceTxosAfter = await aliceWallet.TXOs(TXIDVersion.V2_PoseidonMerkle, chain);
  const spentPositions = new Set(aliceTxos.filter(t => t.spendtxid !== false).map(t => t.position));
  for (const txo of aliceTxosAfter) {
    if (txo.spendtxid !== false) continue;
    if (spentPositions.has(txo.position)) continue; // skip original notes
    // This is a new (change) note
    console.log(`  Change note: tree=${txo.tree} pos=${txo.position} value=${ethers.formatUnits(txo.note.value, 6)}`);
    outputs.push({
      notePublicKey: toHex(txo.note.notePublicKey),
      tokenAddress: txo.note.tokenData.tokenAddress,
      tokenHash: txo.note.tokenHash,
      value: txo.note.value.toString(),
      random: txo.note.random,
      recipientAddress: aliceShieldedAddress,
    });
  }

  console.log(`Total outputs captured: ${outputs.length} (expected ${numCommitments})`);

  // ── Build fixture ────────────────────────────────────────
  const vector: TransferVector = {
    operation: 'transfer',
    shape: { nullifiers: numNullifiers, commitments: numCommitments },
    chainId: deployments.chainId,
    inputs: inputWitnesses,
    keys: {
      nullifyingKey: toHex(nullifyingKey),
      spendingPublicKey: spendingKeyPair.pubkey.map((p: bigint) => toHex(p)) as [string, string],
    },
    eddsaSignature: {
      R8: [toHex(eddsaSig.R8[0]), toHex(eddsaSig.R8[1])],
      S: toHex(eddsaSig.S),
    },
    outputs,
    transactionStruct: {
      merkleRoot: toHex(BigInt(provedTx.merkleRoot)),
      nullifiers: provedTx.nullifiers.map((n: any) => toHex(BigInt(n))),
      commitments: provedTx.commitments.map((c: any) => toHex(BigInt(c))),
      boundParams: provedTx.boundParams,
      unshieldPreimage: provedTx.unshieldPreimage,
      proof: serializeProof(provedTx.proof),
    },
    publicSignals,
    boundParamsHash,
    txHash: txHash,
    metadata: {
      tokenAddress: usdcAddress,
      transferAmount: amount.toString(),
      senderAddress: aliceShieldedAddress,
      recipientAddress: bobShieldedAddress,
    },
  };

  const filename = `${operation === 'unshield' ? 'unshield' : 'transfer'}-${numNullifiers}x${numCommitments}.json`;
  const fixturePath = path.join(FIXTURES_DIR, filename);
  writeJSON(fixturePath, vector);
  console.log(`\n✓ Written: ${fixturePath}`);
}

// ── Main ───────────────────────────────────────────────────

async function main() {
  console.log('='.repeat(60));
  console.log('  Multi-Shape Reference Vector Capture');
  console.log('='.repeat(60));

  fs.mkdirSync(FIXTURES_DIR, { recursive: true });

  const [deployer, aliceSigner, bobSigner] = await ethers.getSigners();

  const privacyPool = await ethers.getContractAt('PrivacyPool', deployments.contracts.privacyPool);
  const usdc = await ethers.getContractAt('MockUSDCV2', deployments.cctp.usdc);
  const usdcAddress = await usdc.getAddress();

  // Load verification keys (only needed once per contract deployment)
  console.log('\nLoading verification keys...');
  await loadVerificationKeys(privacyPool, TESTING_ARTIFACT_CONFIGS, true);

  const chain = getChainById(deployments.chainId)!;

  // ── Shape configurations ─────────────────────────────────
  const shapes: ShapeConfig[] = [
    {
      name: '2x2',
      description: '2 inputs (50+50), transfer 80 → 2 outputs (80 + 20 change)',
      shieldAmounts: [ethers.parseUnits('50', 6), ethers.parseUnits('50', 6)],
      amount: ethers.parseUnits('80', 6),
      operation: 'transfer',
    },
    {
      name: '1x1',
      description: '1 input (exact spend), transfer full 99.5 USDC UTXO → 1 output (no change)',
      shieldAmounts: [ethers.parseUnits('100', 6)],
      amount: ethers.parseUnits('99.5', 6),
      operation: 'transfer',
    },
    {
      name: '3x2',
      description: '3 inputs (30+30+30), transfer 70 → 2 outputs (70 + 20 change)',
      shieldAmounts: [ethers.parseUnits('30', 6), ethers.parseUnits('30', 6), ethers.parseUnits('30', 6)],
      amount: ethers.parseUnits('70', 6),
      operation: 'transfer',
    },
    {
      name: '2x1-unshield',
      description: '2 inputs (50+50), unshield 80 to public address → 1 output (change)',
      shieldAmounts: [ethers.parseUnits('50', 6), ethers.parseUnits('50', 6)],
      amount: ethers.parseUnits('80', 6),
      operation: 'unshield',
    },
  ];

  // ── Capture each shape ───────────────────────────────────
  for (const shape of shapes) {
    await captureShape(shape, aliceSigner, bobSigner, privacyPool, usdc, usdcAddress, chain);
  }

  console.log('\n' + '='.repeat(60));
  console.log('  ALL SHAPES CAPTURED');
  console.log('='.repeat(60));
  console.log(`  Fixtures: ${FIXTURES_DIR}`);

  await shutdownEngine();
}

main().catch(async (err) => {
  console.error('Capture failed:', err);
  try { await shutdownEngine(); } catch { /* ignore */ }
  process.exit(1);
});
