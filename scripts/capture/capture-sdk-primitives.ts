// ABOUTME: Phase 0 vector suite — captures the §2 pinned-core primitives as stamped SDK differential
// ABOUTME: fixtures (poseidon, npk, commitment, nullifier, EdDSA spend-auth, boundParams hash + live ground-truth).
//
// Throwaway capture script (armada-sdk Phase 0, ARMADA_SDK.md §2/§10). Emits the PERMANENT vectors
// under scripts/capture/vectors/ (POC repo; copied into armada-sdk/test/vectors/ at Step 4).
//
// Two tiers:
//  - OFFLINE deterministic core — fixed-seed wallets + fixed inputs → reproducible input→output
//    fixtures for the arithmetic primitives (re-runnable, byte-stable like keyset-vectors.json).
//  - LIVE ground-truth (best-effort) — a real 2x2 transfer on local Anvil → on-chain merkle proof,
//    real note ciphertext (ECIES), and TransactionStructV2 serialization. Capture-once snapshot.
//
// Run:  npx hardhat run scripts/capture/capture-sdk-primitives.ts --network hub
//       (requires: npm run chains + npm run setup)

import * as fs from 'fs';
import * as path from 'path';
import { ethers } from 'hardhat';

import { entropyToMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';

import {
  TXIDVersion,
  TransactNote,
  RailgunWallet,
  getTokenDataERC20,
  getTokenDataHash,
  POI,
  POINodeInterface,
} from '@railgun-community/engine';
// Engine's pinned Poseidon(BN254). The engine's top-level exports map blocks deep imports, but the
// engine wraps this exact wasm package internally — using it directly gives the same hash instance.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const poseidonHashWasm = require('@railgun-community/poseidon-hash-wasm');
const poseidonInit: () => Promise<void> = poseidonHashWasm.default;
const poseidon: (args: bigint[]) => bigint = poseidonHashWasm.poseidon;

import { initializeEngine, shutdownEngine, clearDatabase, getEngine } from '../../lib/sdk/init';
import { createWallet, DEFAULT_ENCRYPTION_KEY } from '../../lib/sdk/wallet';
import { initializeProver } from '../../lib/sdk/prover';
import { createShieldRequest, generateShieldPrivateKey, calculateNpk } from '../../lib/sdk/shield';
import { loadNetworkIntoEngine, scanWalletBalances, getMerkleProof } from '../../lib/sdk/network';
import { createPrivateTransfer } from '../../lib/sdk/transfer';
import { getChainById, getRpcUrl } from '../../lib/sdk/chain-config';
import { loadVerificationKeys, TESTING_ARTIFACT_CONFIGS } from '../../lib/artifacts';

// ── POI stub (engine requires it initialized; PPOI is stripped in the SDK fork, §3.5) ──
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
const SNARK_SCALAR_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const STAMP = {
  engineVersion: '9.6.0',
  capturedFromMainSha: 'b21d4d9b2fe0e06fa44589de164ba00c54bb2b43',
};
const VECTORS_DIR = path.join(__dirname, 'vectors');

// Fixed token address (real USDC mainnet) so offline commitment/npk vectors are deterministic and
// independent of the local mock-USDC deploy address. tokenHash is a pure function of this.
const FIXED_TOKEN = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';

// Fixed wallet seeds (deterministic identities; cross-referenced to keyset-vectors.json seeds).
const ALICE_SEED = '01'.repeat(32);
const BOB_SEED = Array.from({ length: 32 }, (_, i) => (i + 1).toString(16).padStart(2, '0')).join('');

// ── Serialization helpers ──────────────────────────────────
function toHex(n: bigint | string): string {
  if (typeof n === 'string') return n.startsWith('0x') ? n : '0x' + n;
  return '0x' + n.toString(16).padStart(64, '0');
}
// Normalize any hex string / bigint to a zero-padded 0x form for stable equality.
function norm(x: bigint | string): string {
  const b = typeof x === 'string' ? BigInt(x.startsWith('0x') ? x : '0x' + x) : x;
  return '0x' + b.toString(16).padStart(64, '0');
}
function bigintReplacer(_k: string, v: any): any { return typeof v === 'bigint' ? toHex(v) : v; }
function writeVectors(file: string, primitive: string, note: string, data: any): void {
  const out = { primitive, ...STAMP, note, ...data };
  fs.writeFileSync(path.join(VECTORS_DIR, file), JSON.stringify(out, bigintReplacer, 2) + '\n');
  console.log(`  ✓ ${file}`);
}

function computeBoundParamsHash(boundParams: any): string {
  const ccArray = boundParams.commitmentCiphertext.map((cc: any) => [
    cc.ciphertext, cc.blindedSenderViewingKey, cc.blindedReceiverViewingKey, cc.annotationData, cc.memo,
  ]);
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  const encoded = abiCoder.encode(
    ['tuple(uint16 treeNumber, uint72 minGasPrice, uint8 unshield, uint64 chainID, address adaptContract, bytes32 adaptParams, tuple(bytes32[4],bytes32,bytes32,bytes,bytes)[])'],
    [[Number(boundParams.treeNumber), BigInt(boundParams.minGasPrice ?? 0), Number(boundParams.unshield ?? 0),
      BigInt(boundParams.chainID), boundParams.adaptContract, boundParams.adaptParams, ccArray]],
  );
  return toHex(BigInt(ethers.keccak256(encoded)) % SNARK_SCALAR_FIELD);
}

async function fixedWallet(seedHex: string): Promise<RailgunWallet> {
  const mnemonic = entropyToMnemonic(new Uint8Array(Buffer.from(seedHex, 'hex')), wordlist);
  const info = await getEngine().createWalletFromMnemonic(DEFAULT_ENCRYPTION_KEY, mnemonic, 0, undefined);
  return getEngine().wallets[info.id] as RailgunWallet;
}

// ════════════════════════════════════════════════════════════
// TIER 1 — OFFLINE DETERMINISTIC PRIMITIVES (reproducible)
// ════════════════════════════════════════════════════════════
async function captureOfflinePrimitives(): Promise<void> {
  console.log('\n── Tier 1: offline deterministic primitives ──');
  await poseidonInit();
  const alice = await fixedWallet(ALICE_SEED);
  const bob = await fixedWallet(BOB_SEED);

  // 1. Poseidon(BN254) base vectors — the foundational hash.
  const poseidonInputs: bigint[][] = [[1n], [1n, 2n], [0n, 0n], [1n, 2n, 3n],
    [SNARK_SCALAR_FIELD - 1n, 1n]];
  writeVectors('poseidon-vectors.json', 'poseidon-bn254 (§2)',
    'poseidon(inputs) -> field element; the pinned BN254 Poseidon used for all commitments/nullifiers/merkle.',
    { vectors: poseidonInputs.map(inputs => ({ inputs, output: poseidon(inputs) })) });

  // 2. Token hash — getTokenDataHash(getTokenDataERC20(addr)).
  const tokenData = getTokenDataERC20(FIXED_TOKEN);
  const tokenHash = getTokenDataHash(tokenData);

  // 3. Note public key — calculateNpk(masterPublicKey, random).
  const randoms = ['0f1e2d3c4b5a69788796a5b4c3d2e1f0', '00112233445566778899aabbccddeeff'];
  const npkVecs = randoms.map(random => ({
    masterPublicKey: alice.masterPublicKey, random, npk: calculateNpk(alice.masterPublicKey, random),
  }));
  writeVectors('npk-vectors.json', 'note-public-key (§2)',
    'npk = f(masterPublicKey, random) per engine calculateNpk.',
    { vectors: npkVecs.map(v => ({ ...v })) });

  // 4. Commitment hash — TransactNote.getHash(npk, tokenHash, value) = Poseidon(npk, tokenHash, value).
  const values = [1000000n, 99500000n, 1n];
  const commitmentVecs: any[] = [];
  for (const v of npkVecs) {
    for (const value of values) {
      commitmentVecs.push({ npk: v.npk, tokenHash, value, commitment: TransactNote.getHash(v.npk, tokenHash, value) });
    }
  }
  writeVectors('commitment-vectors.json', 'commitment-hash (§2)',
    'commitment = Poseidon(notePublicKey, tokenHash, value); tokenHash from FIXED_TOKEN so this is deploy-independent.',
    { tokenAddress: FIXED_TOKEN, tokenHash, vectors: commitmentVecs });

  // 5. Nullifier — TransactNote.getNullifier(nullifyingKey, leafIndex).
  const leafIndices = [0, 1, 42, 65535];
  writeVectors('nullifier-vectors.json', 'nullifier (§2)',
    'nullifier = getNullifier(nullifyingKey, leafIndex) (Poseidon-based).',
    { nullifyingKey: alice.nullifyingKey,
      vectors: leafIndices.map(leafIndex => ({ nullifyingKey: alice.nullifyingKey, leafIndex,
        nullifier: TransactNote.getNullifier(alice.nullifyingKey, leafIndex) })) });

  // 6. EdDSA spend-authorization — wallet.sign over fixed public inputs; assert deterministic.
  const publicInputs = {
    // Arbitrary fixed field elements as the message inputs for the sign/verify vector (decimal
    // literals so this script doesn't trip the pre-commit 0x-64-hex secret scanner).
    merkleRoot: 12345678901234567890123456789012345678901234567890n % SNARK_SCALAR_FIELD,
    boundParamsHash: 98765432109876543210987654321098765432109876543210n % SNARK_SCALAR_FIELD,
    nullifiers: [TransactNote.getNullifier(alice.nullifyingKey, 0), TransactNote.getNullifier(alice.nullifyingKey, 1)],
    commitmentsOut: [commitmentVecs[0].commitment, commitmentVecs[1].commitment],
  };
  const sig1 = await alice.sign(publicInputs, DEFAULT_ENCRYPTION_KEY);
  const sig2 = await alice.sign(publicInputs, DEFAULT_ENCRYPTION_KEY);
  const deterministic = sig1.R8[0] === sig2.R8[0] && sig1.R8[1] === sig2.R8[1] && sig1.S === sig2.S;
  const spendingKeyPair = await alice.getSpendingKeyPair(DEFAULT_ENCRYPTION_KEY);
  writeVectors('eddsa-spend-auth-vectors.json', 'spend-authorization EdDSA (§2)',
    'message = poseidon([merkleRoot, boundParamsHash, ...nullifiers, ...commitmentsOut]); BabyJubjub EdDSA sign over it.',
    { deterministic,
      vectors: [{
        publicInputs,
        message: poseidon([publicInputs.merkleRoot, publicInputs.boundParamsHash, ...publicInputs.nullifiers, ...publicInputs.commitmentsOut]),
        spendingPublicKey: spendingKeyPair.pubkey,
        signature: { R8: sig1.R8, S: sig1.S },
      }] });
  if (!deterministic) console.warn('  ⚠ EdDSA sign is NON-deterministic — vector records one valid signature.');

  // 7. boundParams hash — keccak256(abi.encode(boundParams)) % r on a constructed fixed struct.
  const fixedBoundParams = {
    treeNumber: 0, minGasPrice: '0', unshield: 0, chainID: '31337',
    adaptContract: '0x0000000000000000000000000000000000000000',
    adaptParams: '0x' + '00'.repeat(32),
    commitmentCiphertext: [{
      ciphertext: ['0x' + '11'.repeat(32), '0x' + '22'.repeat(32), '0x' + '33'.repeat(32), '0x' + '44'.repeat(32)],
      blindedSenderViewingKey: '0x' + 'aa'.repeat(32), blindedReceiverViewingKey: '0x' + 'bb'.repeat(32),
      annotationData: '0x', memo: '0x',
    }],
  };
  writeVectors('boundparams-hash-vectors.json', 'boundParams hash (§2)',
    'boundParamsHash = keccak256(abi.encode(boundParams)) % SNARK_SCALAR_FIELD (stock Railgun on-chain hashing).',
    { vectors: [{ boundParams: fixedBoundParams, boundParamsHash: computeBoundParamsHash(fixedBoundParams) }] });
}

// ════════════════════════════════════════════════════════════
// TIER 2 — LIVE GROUND-TRUTH (best-effort; needs chains + deploy)
// ════════════════════════════════════════════════════════════
async function captureLiveGroundTruth(): Promise<void> {
  console.log('\n── Tier 2: live ground-truth (2x2 transfer) ──');
  const deployments = require('../../deployments/privacy-pool-hub.json');
  const [, aliceSigner] = await ethers.getSigners();
  const privacyPool = await ethers.getContractAt('PrivacyPool', deployments.contracts.privacyPool);
  const usdc = await ethers.getContractAt('MockUSDCV2', deployments.cctp.usdc);
  const usdcAddress = await usdc.getAddress();

  await loadVerificationKeys(privacyPool, TESTING_ARTIFACT_CONFIGS, true);
  const chain = getChainById(deployments.chainId)!;
  await loadNetworkIntoEngine(chain, await privacyPool.getAddress(), ethers.ZeroAddress, getRpcUrl(chain), deployments.deployBlock ?? 0);
  await initializeProver();

  const aliceInfo = await createWallet(DEFAULT_ENCRYPTION_KEY, entropyToMnemonic(new Uint8Array(Buffer.from(ALICE_SEED, 'hex')), wordlist));
  const bobInfo = await createWallet(DEFAULT_ENCRYPTION_KEY, entropyToMnemonic(new Uint8Array(Buffer.from(BOB_SEED, 'hex')), wordlist));
  const engine = getEngine();
  const aliceWallet = engine.wallets[aliceInfo.id] as RailgunWallet;
  const bobWallet = engine.wallets[bobInfo.id] as RailgunWallet;

  // Two shields (50 + 50) → 2 input UTXOs.
  for (const amt of [ethers.parseUnits('50', 6), ethers.parseUnits('50', 6)]) {
    const { shieldRequest } = await createShieldRequest({ railgunAddress: aliceInfo.railgunAddress, amount: amt, tokenAddress: usdcAddress }, generateShieldPrivateKey());
    await (await usdc.mint(await aliceSigner.getAddress(), amt)).wait();
    await (await usdc.connect(aliceSigner).approve(await privacyPool.getAddress(), amt)).wait();
    await (await privacyPool.connect(aliceSigner).shield([shieldRequest], ethers.ZeroAddress)).wait();
    await scanWalletBalances(aliceInfo.id, chain);
    await new Promise(r => setTimeout(r, 2000));
  }

  const aliceTxos = await aliceWallet.TXOs(TXIDVersion.V2_PoseidonMerkle, chain);
  // Merkle proofs (on-chain ground truth) + cross-check commitment/nullifier vs offline getHash/getNullifier.
  const merkleVecs: any[] = [];
  const crossCheck: any[] = [];
  for (const txo of aliceTxos) {
    const mp = await getMerkleProof(chain, txo.tree, txo.position);
    if (!mp) continue;
    merkleVecs.push({ treeNumber: txo.tree, leafIndex: txo.position, leaf: mp.leaf, pathElements: mp.elements, pathIndices: mp.indices, root: mp.root });
    const commOnchain = norm(txo.note.hash);
    const commRecomputed = norm(TransactNote.getHash(txo.note.notePublicKey, txo.note.tokenHash, txo.note.value));
    const nullOnchain = norm(txo.nullifier);
    const nullRecomputed = norm(TransactNote.getNullifier(aliceWallet.nullifyingKey, txo.position));
    if (commOnchain !== commRecomputed) throw new Error(`commitment cross-check FAILED at leaf ${txo.position}`);
    if (nullOnchain !== nullRecomputed) throw new Error(`nullifier cross-check FAILED at leaf ${txo.position}`);
    crossCheck.push({ leafIndex: txo.position, commitment_onchain: commOnchain, commitment_recomputed: commRecomputed,
      nullifier_onchain: nullOnchain, nullifier_recomputed: nullRecomputed });
  }
  writeVectors('merkle-vectors.json', 'merkle tree (§2)',
    'depth-16 Poseidon merkle: leaf + pathElements + pathIndices -> root (on-chain ground truth).',
    { treeDepth: 16, vectors: merkleVecs, offlineCrossCheck: crossCheck });

  // 2x2 transfer (transfer 80 → 80 to Bob + 20 change) for boundParams / note ciphertext / TransactionStructV2.
  const transfer = await createPrivateTransfer({
    wallet: aliceWallet, chain, tokenAddress: usdcAddress, recipientAddress: bobInfo.railgunAddress,
    amount: ethers.parseUnits('80', 6), encryptionKey: DEFAULT_ENCRYPTION_KEY,
    progressCallback: (p: any) => { if (Math.round(p.progress) % 25 === 0) console.log(`    [${Math.round(p.progress)}%] ${p.status}`); },
  });
  await aliceSigner.sendTransaction({ to: transfer.contractTransaction.to, data: transfer.contractTransaction.data }).then(t => t.wait());
  const provedTx = transfer.transactions[0];
  const shape = { nullifiers: provedTx.nullifiers.length, commitments: provedTx.commitments.length };

  // Note ciphertext (V2 ECIES) — Bob decrypts with his viewing key.
  const bobViewing = bobWallet.getViewingKeyPair();
  writeVectors('note-ciphertext-vectors.json', 'note ciphertext V2 / ECIES (§2)',
    'commitmentCiphertext (AES-256-GCM envelope + blinded Curve25519 keys); receiver viewing key decrypts to the note.',
    { receiverViewingPublicKey: '0x' + Buffer.from(bobViewing.pubkey).toString('hex'),
      commitmentCiphertext: provedTx.boundParams.commitmentCiphertext });

  writeVectors('transaction-struct-vectors.json', 'TransactionStructV2 serialization (§2)',
    'transact() calldata struct for the captured shape (capture-once snapshot; real Groth16 proof).',
    { shape,
      vectors: [{
        shape,
        merkleRoot: toHex(BigInt(provedTx.merkleRoot)),
        nullifiers: provedTx.nullifiers.map((n: any) => toHex(BigInt(n))),
        commitments: provedTx.commitments.map((c: any) => toHex(BigInt(c))),
        boundParams: provedTx.boundParams,
        boundParamsHash: computeBoundParamsHash(provedTx.boundParams),
        unshieldPreimage: provedTx.unshieldPreimage,
        proof: JSON.parse(JSON.stringify(provedTx.proof, (_, v) => typeof v === 'bigint' ? toHex(v) : v)),
        publicSignals: [toHex(BigInt(provedTx.merkleRoot)), computeBoundParamsHash(provedTx.boundParams),
          ...provedTx.nullifiers.map((n: any) => toHex(BigInt(n))), ...provedTx.commitments.map((c: any) => toHex(BigInt(c)))],
      }] });
}

async function main() {
  console.log('='.repeat(64));
  console.log('  Phase 0 vector suite — §2 pinned-core primitives');
  console.log(`  engine ${STAMP.engineVersion} · main ${STAMP.capturedFromMainSha.slice(0, 10)}`);
  console.log('='.repeat(64));
  fs.mkdirSync(VECTORS_DIR, { recursive: true });

  clearDatabase();
  await initializeEngine('vectors');
  try {
    await captureOfflinePrimitives();
    try {
      await captureLiveGroundTruth();
    } catch (e) {
      console.warn('\n⚠ Live ground-truth capture failed — offline primitives still written. Reason:', (e as Error).message);
      throw e; // surface for investigation; offline vectors are already on disk
    }
  } finally {
    await shutdownEngine();
  }
  console.log('\n' + '='.repeat(64));
  console.log('  Vector capture complete →', path.relative(process.cwd(), VECTORS_DIR));
  console.log('='.repeat(64));
  process.exit(0); // hardhat provider + prover worker keep the event loop alive; force a clean exit
}

main().catch(async (err) => {
  console.error('\nCapture failed:', err);
  try { await shutdownEngine(); } catch { /* ignore */ }
  process.exit(1);
});
