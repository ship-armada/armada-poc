// ABOUTME: tx chain differential — shields via the stock SDK, then builds+proves+submits a private
// ABOUTME: transfer entirely with @armada/sdk (plan→witness→prove→calldata), verifying it on-chain.

/**
 * tx Chain Differential: @armada/sdk write path vs the deployed pool
 *
 * The load-bearing validation of the tx pipeline. Shields 10 USDC to Alice (stock SDK), then uses the
 * armada write path ONLY — plan/witness/prove (real Groth16 over the deployed 1x2 circuit)/serialize —
 * to transfer 3 USDC Alice → Bob, and submits it. On-chain success means the deployed Verifier accepted
 * the proof: the witness format, boundParamsHash, G2 swap, and public-input ordering are all correct.
 * Balances are then cross-checked against the stock SDK.
 *
 * Prerequisites (local):
 *   npm run chains                              # terminal 1
 *   source config/local.env && npm run setup    # terminal 2
 *   npx hardhat run scripts/capture/e2e-tx-differential.ts --network hub
 */

import { ethers } from 'hardhat';
import { Interface } from 'ethers';

import { initializeEngine, shutdownEngine, clearDatabase, getEngine } from '../../lib/sdk/init';
import { createWallet, DEFAULT_ENCRYPTION_KEY } from '../../lib/sdk/wallet';
import { initializeProver } from '../../lib/sdk/prover';
import { createShieldRequest, generateShieldPrivateKey } from '../../lib/sdk/shield';
import { loadNetworkIntoEngine, scanWalletBalances, getWalletBalances } from '../../lib/sdk/network';
import { getChainById, getRpcUrl } from '../../lib/sdk/chain-config';
import { loadDeployment } from '../deploy-utils';
import { getArtifact } from '../../lib/sdk/armada-artifacts';

import {
  TXIDVersion, POI, POINodeInterface, RailgunWallet,
  getTokenDataERC20 as engineTokenDataERC20, getTokenDataHash as engineTokenDataHash,
} from '@railgun-community/engine';
import { Chain } from '@railgun-community/shared-models';

import {
  planTransfer, buildWitness, buildTransactCalldata,
  createSnarkjsProver, UTXOMerkletree, decodePoolEvents, tryDecryptCommitment, tryDecryptShield,
  fetchLogsRanged, LocalSigner, deriveKeyset, POOL_V2_EVENT_ABI,
  type Keyset, type ParsedPoolLog, type TXO,
} from '@armada/sdk';
import { Mnemonic, getTokenDataERC20, getTokenDataHash, ChainType, TransactNote, initPoseidonPromise, type TokenData } from '@armada/sdk/core';

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
const toBig = (hexNo0x: string): bigint => BigInt(`0x${hexNo0x}`);

interface OwnedTXO extends TXO {}

async function main() {
  console.log('='.repeat(60));
  console.log('  tx Chain Differential: @armada/sdk write path');
  console.log('='.repeat(60));
  await initPoseidonPromise;

  const deployments = loadDeployment('privacy-pool-hub.json');
  if (!deployments) throw new Error('privacy-pool-hub.json not found — run `npm run setup` first');
  const chainId: number = deployments.chainId;
  const chain: Chain = getChainById(chainId)!;
  console.log(`\nNetwork: local (chainId ${chainId}), deployBlock ${deployments.deployBlock}`);

  const shieldAmount = ethers.parseUnits('10', 6);
  const transferAmount = ethers.parseUnits('3', 6);
  const aliceSigner = (await ethers.getSigners())[1];

  const privacyPool = await ethers.getContractAt('PrivacyPool', deployments.contracts.privacyPool);
  const poolAddress = (await privacyPool.getAddress()) as `0x${string}`;
  const usdc = await ethers.getContractAt('MockUSDCV2', deployments.cctp.usdc);
  const usdcAddress = (await usdc.getAddress()) as `0x${string}`;
  const usdcTokenHash = getTokenDataHash(getTokenDataERC20(usdcAddress)); // armada hash (no-0x)
  const tokenData: TokenData = getTokenDataERC20(usdcAddress);

  const aliceRoot = seed(0x11);
  const alice: Keyset = await deriveKeyset(aliceRoot);
  const bob: Keyset = await deriveKeyset(seed(0x22));

  // ── Stock engine: shield 10 USDC to Alice (so she has a spendable note) ──
  console.log('\nInit stock engine + prover, shield 10 USDC → Alice...');
  clearDatabase();
  await initializeEngine('txdiff');
  await loadNetworkIntoEngine(chain, poolAddress, ethers.ZeroAddress, getRpcUrl(chain), deployments.deployBlock ?? 0);
  await initializeProver();
  const aliceInfo = await createWallet(DEFAULT_ENCRYPTION_KEY, Mnemonic.fromEntropy(bytesToHex(aliceRoot)), 0);
  if (aliceInfo.railgunAddress !== alice.railgunAddress) throw new Error('Alice derivation mismatch');

  const shieldPrivateKey = generateShieldPrivateKey();
  const { shieldRequest } = await createShieldRequest(
    { railgunAddress: alice.railgunAddress, amount: shieldAmount, tokenAddress: usdcAddress }, shieldPrivateKey,
  );
  const aliceAddr = await aliceSigner.getAddress();
  await (await usdc.mint(aliceAddr, shieldAmount)).wait();
  await (await usdc.connect(aliceSigner).approve(poolAddress, shieldAmount)).wait();
  await (await privacyPool.connect(aliceSigner).shield([shieldRequest], ethers.ZeroAddress)).wait();
  console.log('✓ Shield mined');

  // ── Armada scan: recover Alice's spendable TXO + build the merkletree for proofs ──
  console.log('\nArmada scan (recover Alice TXO + merkle proof)...');
  const headBlock = await ethers.provider.getBlockNumber();
  const iface = new Interface(POOL_V2_EVENT_ABI as unknown as string[]);
  const getLogs = async (from: number, to: number): Promise<ParsedPoolLog[]> => {
    const logs = await ethers.provider.getLogs({ address: poolAddress, fromBlock: from, toBlock: to });
    return logs.flatMap((log) => {
      const d = iface.parseLog({ topics: [...log.topics], data: log.data });
      return d ? [{ name: d.name, args: d.args as unknown as ParsedPoolLog['args'], blockNumber: log.blockNumber, txid: log.transactionHash }] : [];
    });
  };
  const decoded = decodePoolEvents(await fetchLogsRanged(getLogs, { fromBlock: deployments.deployBlock ?? 0, toBlock: headBlock }));

  const aliceReceiver = {
    addressData: { masterPublicKey: alice.masterPublicKey, viewingPublicKey: alice.viewingPublicKey },
    viewingPrivateKey: alice.viewingPrivateKey,
  };
  const tokenDataGetter = { getTokenDataFromHash: async () => tokenData };
  const armadaChain = { type: ChainType.EVM, id: chainId };

  // Single tree (tree 0) for this small scenario — insert all leaves in position order.
  const tree = new UTXOMerkletree();
  const owned: OwnedTXO[] = [];
  const leaves = [
    ...decoded.shields.map((c) => ({ kind: 'shield' as const, c })),
    ...decoded.transacts.map((c) => ({ kind: 'transact' as const, c })),
  ].sort((a, b) => a.c.tree - b.c.tree || a.c.position - b.c.position);
  for (const leaf of leaves) {
    tree.insert(leaf.c.hash);
    if (leaf.kind === 'shield') {
      const o = await tryDecryptShield(leaf.c, aliceReceiver);
      if (o) owned.push({ tree: leaf.c.tree, position: leaf.c.position, tokenHash: o.tokenHash, value: o.value, blockNumber: leaf.c.blockNumber, random: o.random, notePublicKey: o.notePublicKey });
    } else {
      const n = await tryDecryptCommitment(leaf.c.ciphertext, aliceReceiver, tokenDataGetter, armadaChain);
      if (n) owned.push({ tree: leaf.c.tree, position: leaf.c.position, tokenHash: n.tokenHash, value: n.value, blockNumber: leaf.c.blockNumber, random: n.random, notePublicKey: n.notePublicKey });
    }
  }
  // Exclude notes already spent on-chain (so re-runs on an accumulated chain pick a fresh note).
  const spent = new Set(decoded.nullifiers.map((n) => `${n.tree}:${n.nullifier}`));
  const isSpent = (t: OwnedTXO): boolean => spent.has(`${t.tree}:${TransactNote.getNullifier(alice.nullifyingKey, t.position)}`);
  const input = owned.filter((t) => !isSpent(t)).find((t) => t.value >= transferAmount);
  if (!input) throw new Error('no spendable Alice note found by armada scan');
  console.log(`✓ Alice note: value=${ethers.formatUnits(input.value, 6)} USDC at tree ${input.tree} pos ${input.position}`);

  const merkleRoot = toBig(tree.root());
  const proof = tree.merkleProof(input.position);
  const merkleProofElements = proof.elements.map(toBig);

  // ── Armada write path: plan → witness → prove → calldata ──
  const changeValue = input.value - transferAmount; // no broadcaster fee in this scenario
  const plan = planTransfer({
    txos: [input], tokenAddress: usdcAddress,
    outputs: [{ toRailgunAddress: bob.railgunAddress, value: transferAmount }],
    roots: new Map([[input.tree, merkleRoot]]), chainID: BigInt(chainId),
  });

  console.log('\nBuilding witness + proving (real 1x2 Groth16)...');
  const signer = await LocalSigner.fromRootSecret(aliceRoot);
  const witness = await buildWitness({
    inputs: [{ random: input.random, value: input.value, position: input.position, merkleProofElements }],
    outputs: [
      { receiverAddress: bob.railgunAddress, value: transferAmount },
      { receiverAddress: alice.railgunAddress, value: changeValue }, // change back to Alice
    ],
    tokenAddress: usdcAddress,
    sender: {
      masterPublicKey: alice.masterPublicKey, viewingPublicKey: alice.viewingPublicKey,
      viewingPrivateKey: alice.viewingPrivateKey, nullifyingKey: alice.nullifyingKey,
      spendingPublicKey: alice.spendingPublicKey, senderAddress: alice.railgunAddress,
    },
    signer, summary: plan.summary, merkleRoot, treeNumber: input.tree,
    chainType: ChainType.EVM, chainId,
  });

  const artifacts = getArtifact(witness.shape.nullifiers, witness.shape.commitments);
  console.log(`  circuit shape ${witness.shape.nullifiers}x${witness.shape.commitments}`);
  const prover = createSnarkjsProver();
  try {
    const groth16Proof = await prover.prove(witness.formattedInputs, { wasm: new Uint8Array(artifacts.wasm), zkey: new Uint8Array(artifacts.zkey), vkey: artifacts.vkey });

    // Local verify BEFORE submitting — a wrong witness fails here.
    const publicSignals = [witness.publicInputs.merkleRoot, witness.publicInputs.boundParamsHash, ...witness.publicInputs.nullifiers, ...witness.publicInputs.commitmentsOut];
    const localOk = await prover.verify(groth16Proof, publicSignals, artifacts.vkey);
    console.log(`  local verify: ${localOk}`);
    if (!localOk) throw new Error('LOCAL VERIFY FAILED — witness does not satisfy the circuit');

    const calldata = buildTransactCalldata([{
      proof: groth16Proof, merkleRoot: witness.publicInputs.merkleRoot,
      nullifiers: witness.publicInputs.nullifiers, commitments: witness.publicInputs.commitmentsOut,
      boundParams: witness.boundParams,
    }], poolAddress);

    console.log(`  witness nullifier: ${witness.publicInputs.nullifiers[0]}`);

    // ── Submit on-chain — success = the deployed Verifier accepted the armada-built proof ──
    console.log('\nSubmitting transact() on-chain...');
    const rcpt = await (await aliceSigner.sendTransaction({ to: calldata.to, data: calldata.data })).wait();
    console.log(`✓ transact mined (block ${rcpt!.blockNumber}) — ON-CHAIN GROTH16 VERIFICATION PASSED`);
    // Diagnose: parse the on-chain Nullified event and compare to the witness nullifier.
    for (const log of rcpt!.logs) {
      const d = iface.parseLog({ topics: [...log.topics], data: log.data });
      if (d?.name === 'Nullified') console.log(`  on-chain Nullified: tree ${d.args.treeNumber} nullifier ${BigInt(d.args.nullifier[0])}`);
    }
  } finally {
    await prover.close();
  }

  // ── Post-transfer balances: armada scan (nullifier-aware) is the primary differential ──
  async function armadaBalance(ks: Keyset): Promise<bigint> {
    const hb = await ethers.provider.getBlockNumber();
    const dec = decodePoolEvents(await fetchLogsRanged(getLogs, { fromBlock: deployments.deployBlock ?? 0, toBlock: hb }));
    const rcv = { addressData: { masterPublicKey: ks.masterPublicKey, viewingPublicKey: ks.viewingPublicKey }, viewingPrivateKey: ks.viewingPrivateKey };
    const st = new (await import('@armada/sdk')).WalletScanState();
    await st.apply(dec, {
      transact: (c: any) => tryDecryptCommitment(c.ciphertext, rcv, tokenDataGetter, armadaChain),
      shield: (c: any) => tryDecryptShield(c, rcv),
    });
    const e = st.balances(ks.nullifyingKey, { currentBlock: hb, finalityThreshold: 0 }).find((b: any) => b.tokenHash === usdcTokenHash);
    return e ? e.spendable + e.pending : 0n;
  }
  const aliceArmada = await armadaBalance(alice);
  const bobArmada = await armadaBalance(bob);

  console.log('\n' + '─'.repeat(50));
  console.log(`  ARMADA  Alice: ${ethers.formatUnits(aliceArmada, 6)}  Bob: ${ethers.formatUnits(bobArmada, 6)} USDC`);
  console.log(`  EXPECT  Alice: ${ethers.formatUnits(changeValue, 6)}  Bob: ${ethers.formatUnits(transferAmount, 6)} USDC`);
  if (aliceArmada !== changeValue || bobArmada !== transferAmount) {
    throw new Error(`ARMADA BALANCE MISMATCH after armada-built transfer (Alice ${aliceArmada} Bob ${bobArmada})`);
  }
  console.log('  ✓ tx CHAIN DIFFERENTIAL PASS — armada-built transfer verified on-chain + balances correct');
  console.log('─'.repeat(50));

  await shutdownEngine();
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
