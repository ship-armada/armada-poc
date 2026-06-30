/**
 * Capture reference proof vectors from a live local deployment.
 *
 * Produces JSON fixtures for differential testing against Armada's
 * independent circuit set.
 *
 * Prerequisites:
 *   cd /Users/andrewburger/armada/armada-poc
 *   npm run chains          # terminal 1 — start Anvil
 *   source config/local.env && npm run setup  # terminal 2 — deploy
 *   npx hardhat run scripts/capture/capture-reference-vectors.ts --network hub
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
import { createPrivateTransfer } from '../../lib/sdk/transfer';
import { getChainById, getRpcUrl } from '../../lib/sdk/chain-config';
import { loadVerificationKeys, TESTING_ARTIFACT_CONFIGS } from '../../lib/artifacts';

// SDK imports — internal POC plumbing
import { TXIDVersion, getTokenDataERC20, getTokenDataHash, POI, POINodeInterface } from '@railgun-community/engine';

// ── POI Stub ───────────────────────────────────────────────
// The engine requires POI to be initialized even when not used.
// This stub reports POI as not-required so all UTXOs are spendable.
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

interface ShieldVector {
  operation: 'shield';
  shape: { nullifiers: number; commitments: number };
  chainId: number;
  shieldPrivateKey: string;
  note: {
    masterPublicKey: string;
    random: string;
    npk: string;
    tokenAddress: string;
    tokenHash: string;
    value: string;
    commitment: string | null;
    merkleTreeNumber: number;
    merkleLeafIndex: number | null;
  };
  shieldRequestStruct: any;
  txHash: string;
  merkleRootAfter: string;
}

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
    merkleProof: {
      leaf: string;
      elements: string[];
      indices: string;
      root: string;
    };
  }>;
  keys: {
    nullifyingKey: string;
    spendingPublicKey: [string, string];
  };
  eddsaSignature: {
    R8: [string, string];
    S: string;
  };
  outputs: Array<{
    notePublicKey: string;
    tokenAddress: string;
    tokenHash: string;
    value: string;
    random: string;
    recipientAddress: string;
  }>;
  transactionStruct: {
    merkleRoot: string;
    nullifiers: string[];
    commitments: string[];
    boundParams: any;
    unshieldPreimage: any;
    proof: { a: [string, string]; b: [[string, string], [string, string]]; c: [string, string] };
  };
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

// BigInt-aware JSON replacer — converts BigInt to hex string
function bigintReplacer(_key: string, value: any): any {
  return typeof value === 'bigint' ? toHex(value) : value;
}

function writeJSON(filePath: string, obj: any): void {
  fs.writeFileSync(filePath, JSON.stringify(obj, bigintReplacer, 2));
}

function computeBoundParamsHash(boundParams: any): string {
  // Encode boundParams as arrays for ethers v6 compatibility
  const ccArray = boundParams.commitmentCiphertext.map((cc: any) => [
    cc.ciphertext,                    // bytes32[4]
    cc.blindedSenderViewingKey,      // bytes32
    cc.blindedReceiverViewingKey,    // bytes32
    cc.annotationData,               // bytes
    cc.memo,                         // bytes
  ]);

  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  const encoded = abiCoder.encode(
    ['tuple(uint16 treeNumber, uint72 minGasPrice, uint8 unshield, uint64 chainID, address adaptContract, bytes32 adaptParams, tuple(bytes32[4],bytes32,bytes32,bytes,bytes)[])'],
    [[
      Number(boundParams.treeNumber),
      BigInt(boundParams.minGasPrice ?? 0),
      Number(boundParams.unshield ?? 0),
      BigInt(boundParams.chainID),
      boundParams.adaptContract,
      boundParams.adaptParams,
      ccArray,
    ]]
  );
  const hash = BigInt(ethers.keccak256(encoded)) % SNARK_SCALAR_FIELD;
  return toHex(hash);
}

function buildPublicInputs(tx: any): string[] {
  const nullifiers = tx.nullifiers.map((n: any) => toHex(BigInt(n)));
  const commitments = tx.commitments.map((c: any) => toHex(BigInt(c)));
  const boundParamsHash = computeBoundParamsHash(tx.boundParams);
  return [
    toHex(BigInt(tx.merkleRoot)),
    boundParamsHash,
    ...nullifiers,
    ...commitments,
  ];
}

function serializeProof(proof: any): any {
  // Capture the raw proof object — exact format depends on SDK version.
  // The proof is typically { a: {x, y}, b: {x: [x1,x2], y: [y1,y2]}, c: {x, y} }
  // or { pi_a: [...], pi_b: [[...], [...]], pi_c: [...] }
  return JSON.parse(JSON.stringify(proof, (_, v) =>
    typeof v === 'bigint' ? toHex(v) : v
  ));
}

// ── Main ───────────────────────────────────────────────────

async function main() {
  console.log('='.repeat(60));
  console.log('  Reference Vector Capture');
  console.log('='.repeat(60));

  fs.mkdirSync(FIXTURES_DIR, { recursive: true });

  const [deployer, aliceSigner, bobSigner] = await ethers.getSigners();
  console.log('Deployer:', await deployer.getAddress());
  console.log('Alice:', await aliceSigner.getAddress());
  console.log('Bob:', await bobSigner.getAddress());

  // ── Load contracts ───────────────────────────────────────
  const privacyPool = await ethers.getContractAt('PrivacyPool', deployments.contracts.privacyPool);
  const usdc = await ethers.getContractAt('MockUSDCV2', deployments.cctp.usdc);
  const usdcAddress = await usdc.getAddress();

  console.log('PrivacyPool:', await privacyPool.getAddress());
  console.log('USDC:', usdcAddress);

  // ── Load verification keys ───────────────────────────────
  console.log('\nLoading verification keys...');
  await loadVerificationKeys(privacyPool, TESTING_ARTIFACT_CONFIGS, true);

  // ── Initialize engine + network ──────────────────────────
  console.log('\nInitializing engine...');
  clearDatabase();
  const engine = await initializeEngine('capture');

  const chain = getChainById(deployments.chainId);
  if (!chain) throw new Error(`Unknown chain ID: ${deployments.chainId}`);
  console.log(`Chain: ${chain.type}:${chain.id}, RPC: ${getRpcUrl(chain)}`);

  await loadNetworkIntoEngine(
    chain,
    await privacyPool.getAddress(),
    ethers.ZeroAddress,
    getRpcUrl(chain),
    deployments.deployBlock ?? 0,
  );

  // ── Initialize prover ────────────────────────────────────
  console.log('\nInitializing prover...');
  await initializeProver();

  // ── Create wallets ───────────────────────────────────────
  console.log('\nCreating wallets...');
  const aliceWalletInfo = await createWallet(DEFAULT_ENCRYPTION_KEY);
  const bobWalletInfo = await createWallet(DEFAULT_ENCRYPTION_KEY);
  const aliceWallet = engine.wallets[aliceWalletInfo.id];
  const bobWallet = engine.wallets[bobWalletInfo.id];

  // Alias the shielded address property to a neutral name
  const aliceShieldedAddress = aliceWalletInfo.railgunAddress;
  const bobShieldedAddress = bobWalletInfo.railgunAddress;

  console.log('Alice shielded:', aliceShieldedAddress);
  console.log('Bob shielded:', bobShieldedAddress);

  // ═══════════════════════════════════════════════════════════
  // 1. SHIELD VECTOR CAPTURE
  // ═══════════════════════════════════════════════════════════

  console.log('\n' + '─'.repeat(40));
  console.log('  Capturing SHIELD vector');
  console.log('─'.repeat(40));

  const shieldAmount = ethers.parseUnits('100', 6);
  const shieldPrivateKey = generateShieldPrivateKey();
  console.log('Shield private key:', shieldPrivateKey);

  // Fund Alice with USDC and approve pool
  await (await usdc.mint(await aliceSigner.getAddress(), shieldAmount)).wait();
  await (await usdc.connect(aliceSigner).approve(await privacyPool.getAddress(), shieldAmount)).wait();

  // Create shield request
  const { shieldRequest, random } = await createShieldRequest(
    {
      railgunAddress: aliceShieldedAddress,
      amount: shieldAmount,
      tokenAddress: usdcAddress,
    },
    shieldPrivateKey,
  );

  // Extract note data
  const masterPublicKey = aliceWallet.masterPublicKey;
  const npk = calculateNpk(aliceWallet.masterPublicKey, random);
  const tokenData = getTokenDataERC20(usdcAddress);
  const tokenHash = getTokenDataHash(tokenData);

  console.log('NPK:', toHex(npk));
  console.log('Token hash:', tokenHash);
  console.log('Value:', shieldAmount.toString());
  console.log('Random:', random);

  // Submit shield on-chain
  const shieldTx = await privacyPool.connect(aliceSigner).shield([shieldRequest], ethers.ZeroAddress);
  const shieldReceipt = await shieldTx.wait();
  console.log('Shield tx:', shieldReceipt!.hash);

  // Wait for engine to pick up the commitment
  console.log('Scanning for shielded note...');
  await scanWalletBalances(aliceWalletInfo.id, chain);
  await new Promise(resolve => setTimeout(resolve, 2000));

  // Get Merkle root after shield
  const merkleRootAfterShield = String(await getMerkleRoot(chain, 0) ?? '0x0');
  console.log('Merkle root after shield:', merkleRootAfterShield);

  // Get shielded UTXOs
  const aliceTxos = await aliceWallet.TXOs(TXIDVersion.V2_PoseidonMerkle, chain);
  console.log(`Alice has ${aliceTxos.length} UTXO(s)`);

  let shieldLeafIndex: number | null = null;
  let shieldCommitment: string | null = null;
  let shieldTreeNumber = 0;

  for (const txo of aliceTxos) {
    console.log(`  UTXO: tree=${txo.tree} position=${txo.position} value=${txo.note.value}`);
    shieldLeafIndex = txo.position;
    shieldTreeNumber = txo.tree;
    shieldCommitment = toHex(txo.note.hash);
    console.log(`  Commitment (note hash): ${shieldCommitment}`);
    console.log(`  Note NPK: ${toHex(txo.note.notePublicKey)}`);
    console.log(`  Note random: ${txo.note.random}`);
  }

  const shieldVector: ShieldVector = {
    operation: 'shield',
    shape: { nullifiers: 0, commitments: 1 },
    chainId: deployments.chainId,
    shieldPrivateKey,
    note: {
      masterPublicKey: toHex(masterPublicKey),
      random,
      npk: toHex(npk),
      tokenAddress: usdcAddress,
      tokenHash,
      value: shieldAmount.toString(),
      commitment: shieldCommitment,
      merkleTreeNumber: shieldTreeNumber,
      merkleLeafIndex: shieldLeafIndex,
    },
    shieldRequestStruct: {
      preimage: {
        npk: toHex(BigInt(shieldRequest.preimage.npk)),
        token: shieldRequest.preimage.token,
        value: shieldRequest.preimage.value.toString(),
      },
      ciphertext: {
        encryptedBundle: shieldRequest.ciphertext.encryptedBundle,
        shieldKey: shieldRequest.ciphertext.shieldKey,
      },
    },
    txHash: shieldReceipt!.hash,
    merkleRootAfter: merkleRootAfterShield,
  };

  const shieldPath = path.join(FIXTURES_DIR, 'shield.json');
  writeJSON(shieldPath, shieldVector);
  console.log('Shield vector written to', shieldPath);

  // ═══════════════════════════════════════════════════════════
  // 2. TRANSFER VECTOR CAPTURE
  // ═══════════════════════════════════════════════════════════

  console.log('\n' + '─'.repeat(40));
  console.log('  Capturing TRANSFER vector');
  console.log('─'.repeat(40));

  // Capture input UTXO witness data BEFORE the transfer
  console.log('\nExtracting input witness data...');
  const inputWitnesses: TransferVector['inputs'] = [];

  for (const txo of aliceTxos) {
    const merkleProof = await getMerkleProof(chain, txo.tree, txo.position);
    if (!merkleProof) {
      throw new Error(`Failed to get Merkle proof for tree=${txo.tree} position=${txo.position}`);
    }

    console.log(`  Input UTXO: tree=${txo.tree} pos=${txo.position}`);
    console.log(`    NPK: ${toHex(txo.note.notePublicKey)}`);
    console.log(`    Value: ${txo.note.value}`);
    console.log(`    Nullifier: ${txo.nullifier}`);
    console.log(`    Merkle root from proof: ${merkleProof.root}`);
    console.log(`    Path elements: ${merkleProof.elements.length} levels`);

    inputWitnesses.push({
      notePublicKey: toHex(txo.note.notePublicKey),
      tokenHash: txo.note.tokenHash,
      tokenAddress: txo.note.tokenData.tokenAddress,
      value: txo.note.value.toString(),
      random: txo.note.random,
      treeNumber: txo.tree,
      leafIndex: txo.position,
      nullifier: txo.nullifier,
      merkleProof: {
        leaf: merkleProof.leaf,
        elements: merkleProof.elements,
        indices: merkleProof.indices,
        root: merkleProof.root,
      },
    });
  }

  // Capture spending keys
  const spendingKeyPair = await aliceWallet.getSpendingKeyPair(DEFAULT_ENCRYPTION_KEY);
  const nullifyingKey = aliceWallet.nullifyingKey;

  console.log('\nSpending public key:', spendingKeyPair.pubkey.map((p: bigint) => toHex(p)));
  console.log('Nullifying key:', toHex(nullifyingKey));

  // Execute the transfer (Alice → Bob)
  const transferAmount = ethers.parseUnits('30', 6);
  console.log(`\nTransferring ${ethers.formatUnits(transferAmount, 6)} USDC to Bob...`);

  const transferResult = await createPrivateTransfer({
    wallet: aliceWallet,
    chain,
    tokenAddress: usdcAddress,
    recipientAddress: bobShieldedAddress,
    amount: transferAmount,
    encryptionKey: DEFAULT_ENCRYPTION_KEY,
    progressCallback: (p) => console.log(`  [${Math.round(p.progress)}%] ${p.status}`),
  });

  // Submit the transfer on-chain
  const transferTx = await aliceSigner.sendTransaction({
    to: transferResult.contractTransaction.to,
    data: transferResult.contractTransaction.data,
  });
  const transferReceipt = await transferTx.wait();
  console.log('Transfer tx:', transferReceipt!.hash);

  // Extract the proved transaction struct
  const provedTx = transferResult.transactions[0];
  const numNullifiers = provedTx.nullifiers.length;
  const numCommitments = provedTx.commitments.length;
  console.log(`Circuit shape: ${numNullifiers}x${numCommitments}`);

  // Extract EdDSA signature — the SDK signs over publicInputs
  // signature = wallet.sign(publicInputs, encryptionKey)
  // publicInputs = { merkleRoot, boundParamsHash, nullifiers, commitmentsOut }
  const publicInputsForSign = {
    merkleRoot: BigInt(provedTx.merkleRoot),
    boundParamsHash: BigInt(computeBoundParamsHash(provedTx.boundParams)),
    nullifiers: provedTx.nullifiers.map((n: any) => BigInt(n)),
    commitmentsOut: provedTx.commitments.map((c: any) => BigInt(c)),
  };
  const eddsaSig = await aliceWallet.sign(publicInputsForSign, DEFAULT_ENCRYPTION_KEY);
  console.log('EdDSA signature:');
  console.log('  R8:', toHex(eddsaSig.R8[0]), toHex(eddsaSig.R8[1]));
  console.log('  S:', toHex(eddsaSig.S));

  // Build public signals
  const publicSignals = buildPublicInputs(provedTx);
  const boundParamsHash = computeBoundParamsHash(provedTx.boundParams);
  console.log('Public signals:', publicSignals);
  console.log('Bound params hash:', boundParamsHash);

  // Extract output note data
  const outputs: TransferVector['outputs'] = [];

  // Scan Bob's wallet to get the received note
  console.log('\nScanning Bob\'s wallet for received note...');
  await scanWalletBalances(bobWalletInfo.id, chain);
  await new Promise(resolve => setTimeout(resolve, 2000));

  const bobTxos = await bobWallet.TXOs(TXIDVersion.V2_PoseidonMerkle, chain);
  console.log(`Bob has ${bobTxos.length} UTXO(s)`);

  for (const txo of bobTxos) {
    console.log(`  Bob UTXO: tree=${txo.tree} pos=${txo.position} value=${txo.note.value}`);
    outputs.push({
      notePublicKey: toHex(txo.note.notePublicKey),
      tokenAddress: txo.note.tokenData.tokenAddress,
      tokenHash: txo.note.tokenHash,
      value: txo.note.value.toString(),
      random: txo.note.random,
      recipientAddress: bobShieldedAddress,
    });
  }

  // Also scan Alice to get change note
  console.log('\nScanning Alice\'s wallet for change note...');
  await scanWalletBalances(aliceWalletInfo.id, chain);
  await new Promise(resolve => setTimeout(resolve, 2000));

  const aliceTxosAfter = await aliceWallet.TXOs(TXIDVersion.V2_PoseidonMerkle, chain);
  console.log(`Alice now has ${aliceTxosAfter.length} UTXO(s)`);
  for (const txo of aliceTxosAfter) {
    const isSpent = txo.spendtxid !== false;
    console.log(`  Alice UTXO: tree=${txo.tree} pos=${txo.position} value=${txo.note.value} spent=${isSpent}`);
    if (!isSpent && txo.position !== shieldLeafIndex) {
      outputs.push({
        notePublicKey: toHex(txo.note.notePublicKey),
        tokenAddress: txo.note.tokenData.tokenAddress,
        tokenHash: txo.note.tokenHash,
        value: txo.note.value.toString(),
        random: txo.note.random,
        recipientAddress: aliceShieldedAddress,
      });
    }
  }

  const transferVector: TransferVector = {
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
    txHash: transferReceipt!.hash,
    metadata: {
      tokenAddress: usdcAddress,
      transferAmount: transferAmount.toString(),
      senderAddress: aliceShieldedAddress,
      recipientAddress: bobShieldedAddress,
    },
  };

  const transferPath = path.join(FIXTURES_DIR, `transfer-${numNullifiers}x${numCommitments}.json`);
  writeJSON(transferPath, transferVector);
  console.log('Transfer vector written to', transferPath);

  // ═══════════════════════════════════════════════════════════
  // 3. RESOLVED PARAMETERS SUMMARY
  // ═══════════════════════════════════════════════════════════

  console.log('\n' + '─'.repeat(40));
  console.log('  Resolved Parameters');
  console.log('─'.repeat(40));

  const summary = {
    timestamp: new Date().toISOString(),
    chainId: deployments.chainId,
    poseidonParameters: {
      notePublicKey: 'Poseidon(Poseidon(spendingPublicKey, nullifyingKey), random)',
      commitment: 'Poseidon(npk, tokenHash, value)',
      nullifier: 'Poseidon(nullifyingKey, leafIndex)',
      merkleNode: 'Poseidon(leftChild, rightChild)',
    },
    notePreimageFields: ['npk', 'token', 'value'],
    tokenHashFields: ['tokenType', 'tokenAddress', 'tokenSubID'],
    capturedVectors: {
      shield: 'shield.json',
      transfer: `transfer-${numNullifiers}x${numCommitments}.json`,
    },
    circuitShape: { nullifiers: numNullifiers, commitments: numCommitments },
    publicInputLayout: ['merkleRoot', 'boundParamsHash', '...nullifiers', '...commitments'],
    merkleTree: {
      depth: 16,
      arity: 2,
      pathElementsLength: inputWitnesses[0]?.merkleProof.elements.length ?? 'unknown',
    },
    boundParamsFields: Object.keys(provedTx.boundParams),
    npkDerivation: 'Poseidon(Poseidon(spendingPublicKey, nullifyingKey), random)',
    tokenHashDerivation: 'hash of (tokenType, tokenAddress, tokenSubID)',
  };

  const summaryPath = path.join(FIXTURES_DIR, 'capture-summary.json');
  writeJSON(summaryPath, summary);
  console.log('Summary written to', summaryPath);

  console.log('\n' + '='.repeat(60));
  console.log('  CAPTURE COMPLETE');
  console.log('='.repeat(60));
  console.log(`  Fixtures: ${FIXTURES_DIR}`);

  await shutdownEngine();
}

main().catch(async (err) => {
  console.error('Capture failed:', err);
  try { await shutdownEngine(); } catch { /* ignore */ }
  process.exit(1);
});
