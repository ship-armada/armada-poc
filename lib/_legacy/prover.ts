/**
 * Railgun ZK Prover - Generates Groth16 proofs for transactions
 *
 * This module:
 * - Constructs circuit witness from transaction inputs
 * - Generates Groth16 proofs using snarkjs
 * - Formats proofs for on-chain verification
 */

import { ethers } from "ethers";
// @ts-ignore
import * as snarkjs from "snarkjs";
import {
  RailgunWallet,
  SpentNote,
  Note,
  poseidonHash,
  computeNpk,
  computeCommitment,
  computeNullifier,
  computeTransactionMessage,
  signMessage,
  initCrypto,
  getTokenId,
  SNARK_SCALAR_FIELD
} from "./wallet";
import { MerkleProof } from "./merkle_tree";

// @ts-ignore
import { getArtifact } from "railgun-circuit-test-artifacts";

// ============ Types ============

export interface TransactionInputs {
  // Notes being spent
  inputNotes: SpentNote[];
  inputProofs: MerkleProof[];

  // Output notes
  outputNotes: Note[];

  // Bound parameters
  boundParams: BoundParams;

  // Wallet for signing
  wallet: RailgunWallet;

  // Optional: unshield preimage for unshield transactions
  unshieldPreimage?: {
    npk: string;  // For unshield, this is the recipient address (zero-padded)
    tokenAddress: string;
    value: bigint;
  };
}

export interface BoundParams {
  treeNumber: number;
  minGasPrice: bigint;
  unshield: number;  // 0 = NONE, 1 = NORMAL, 2 = REDIRECT
  chainId: bigint;
  adaptContract: string;
  adaptParams: string;
  commitmentCiphertext: CommitmentCiphertext[];
}

export interface CommitmentCiphertext {
  ciphertext: [string, string, string, string];  // bytes32[4]
  blindedSenderViewingKey: string;
  blindedReceiverViewingKey: string;
  annotationData: string;
  memo: string;
}

export interface CircuitInputs {
  // Public inputs
  merkleRoot: bigint;
  boundParamsHash: bigint;
  nullifiers: bigint[];
  commitmentsOut: bigint[];

  // Private inputs
  token: bigint;
  publicKey: [bigint, bigint];
  signature: [bigint, bigint, bigint];
  randomIn: bigint[];
  valueIn: bigint[];
  pathElements: bigint[][];
  leavesIndices: bigint[];
  nullifyingKey: bigint;
  npkOut: bigint[];
  valueOut: bigint[];
}

export interface SnarkProof {
  a: { x: bigint; y: bigint };
  b: { x: [bigint, bigint]; y: [bigint, bigint] };
  c: { x: bigint; y: bigint };
}

export interface TransactionData {
  proof: SnarkProof;
  merkleRoot: string;
  nullifiers: string[];
  commitments: string[];
  boundParams: any;
  unshieldPreimage?: any;
}

// ============ Bound Params Encoding ============

/**
 * Create default commitment ciphertext (POC - not encrypted)
 */
export function createMockCiphertext(): CommitmentCiphertext {
  return {
    ciphertext: [
      ethers.zeroPadValue("0x00", 32),
      ethers.zeroPadValue("0x00", 32),
      ethers.zeroPadValue("0x00", 32),
      ethers.zeroPadValue("0x00", 32)
    ],
    blindedSenderViewingKey: ethers.zeroPadValue("0x00", 32),
    blindedReceiverViewingKey: ethers.zeroPadValue("0x00", 32),
    annotationData: "0x",
    memo: "0x"
  };
}

/**
 * Encode bound params for hashing (matches Solidity)
 */
export function encodeBoundParams(params: BoundParams): string {
  // Encode commitmentCiphertext array
  const ciphertextEncoded = params.commitmentCiphertext.map(ct => ({
    ciphertext: ct.ciphertext,
    blindedSenderViewingKey: ct.blindedSenderViewingKey,
    blindedReceiverViewingKey: ct.blindedReceiverViewingKey,
    annotationData: ct.annotationData,
    memo: ct.memo
  }));

  return ethers.AbiCoder.defaultAbiCoder().encode(
    [
      "tuple(uint16 treeNumber, uint72 minGasPrice, uint8 unshield, uint64 chainID, address adaptContract, bytes32 adaptParams, tuple(bytes32[4] ciphertext, bytes32 blindedSenderViewingKey, bytes32 blindedReceiverViewingKey, bytes annotationData, bytes memo)[] commitmentCiphertext)"
    ],
    [{
      treeNumber: params.treeNumber,
      minGasPrice: params.minGasPrice,
      unshield: params.unshield,
      chainID: params.chainId,
      adaptContract: params.adaptContract,
      adaptParams: params.adaptParams,
      commitmentCiphertext: ciphertextEncoded
    }]
  );
}

/**
 * Hash bound params (matches Verifier.hashBoundParams)
 */
export function hashBoundParams(params: BoundParams): bigint {
  const encoded = encodeBoundParams(params);
  const hash = ethers.keccak256(encoded);
  return BigInt(hash) % SNARK_SCALAR_FIELD;
}

// ============ Witness Construction ============

/**
 * Build circuit inputs from transaction data
 */
export async function buildCircuitInputs(
  txInputs: TransactionInputs
): Promise<CircuitInputs> {
  await initCrypto();

  const { inputNotes, inputProofs, outputNotes, boundParams, wallet } = txInputs;

  const numInputs = inputNotes.length;
  const numOutputs = outputNotes.length;

  // Validate
  if (numInputs === 0) throw new Error("Must have at least one input");
  if (numOutputs === 0) throw new Error("Must have at least one output");
  if (inputNotes.length !== inputProofs.length) {
    throw new Error("Input notes and proofs must have same length");
  }

  // All inputs must use same token
  const token = inputNotes[0].token;
  for (const note of inputNotes) {
    if (note.token !== token) {
      throw new Error("All inputs must use same token");
    }
  }
  for (const note of outputNotes) {
    if (note.token !== token) {
      throw new Error("All outputs must use same token");
    }
  }

  // Check balance
  // Note: For unshield transactions, the unshield value is included in outputNotes
  // (as the first output) to satisfy the circuit's balance equation
  const totalIn = inputNotes.reduce((sum, n) => sum + n.value, 0n);
  const totalOut = outputNotes.reduce((sum, n) => sum + n.value, 0n);

  if (totalIn !== totalOut) {
    throw new Error(`Balance mismatch: in=${totalIn} out=${totalOut}`);
  }

  // Use first proof's merkle root (all should be same)
  const merkleRoot = inputProofs[0].root;

  // Compute nullifiers
  const nullifiers = inputNotes.map(note =>
    computeNullifier(wallet.nullifyingKey, BigInt(note.leafIndex))
  );

  // Compute output commitments
  const commitmentsOut = outputNotes.map(note =>
    computeCommitment(note.npk, note.token, note.value)
  );

  // Hash bound params
  const boundParamsHash = hashBoundParams(boundParams);

  // Compute message hash for signing
  const message = computeTransactionMessage(
    merkleRoot,
    boundParamsHash,
    nullifiers,
    commitmentsOut
  );

  // Sign with EdDSA
  const signature = signMessage(wallet.spendingKey, message);

  // Build circuit inputs
  const circuitInputs: CircuitInputs = {
    // Public inputs
    merkleRoot,
    boundParamsHash,
    nullifiers,
    commitmentsOut,

    // Private inputs
    token,
    publicKey: wallet.publicKey,
    signature,
    randomIn: inputNotes.map(n => n.random),
    valueIn: inputNotes.map(n => n.value),
    pathElements: inputProofs.map(p => p.pathElements),
    leavesIndices: inputNotes.map(n => BigInt(n.leafIndex)),
    nullifyingKey: wallet.nullifyingKey,
    npkOut: outputNotes.map(n => n.npk),
    valueOut: outputNotes.map(n => n.value)
  };

  return circuitInputs;
}

/**
 * Format circuit inputs for snarkjs
 */
function formatForSnarkjs(inputs: CircuitInputs): Record<string, any> {
  return {
    merkleRoot: inputs.merkleRoot.toString(),
    boundParamsHash: inputs.boundParamsHash.toString(),
    nullifiers: inputs.nullifiers.map(n => n.toString()),
    commitmentsOut: inputs.commitmentsOut.map(c => c.toString()),
    token: inputs.token.toString(),
    publicKey: inputs.publicKey.map(p => p.toString()),
    signature: inputs.signature.map(s => s.toString()),
    randomIn: inputs.randomIn.map(r => r.toString()),
    valueIn: inputs.valueIn.map(v => v.toString()),
    pathElements: inputs.pathElements.map(pe => pe.map(e => e.toString())),
    leavesIndices: inputs.leavesIndices.map(l => l.toString()),
    nullifyingKey: inputs.nullifyingKey.toString(),
    npkOut: inputs.npkOut.map(n => n.toString()),
    valueOut: inputs.valueOut.map(v => v.toString())
  };
}

// ============ Proof Generation ============

/**
 * Generate Groth16 proof
 */
export async function generateProof(
  circuitInputs: CircuitInputs,
  wasmBuffer: Uint8Array,
  zkeyBuffer: Uint8Array
): Promise<{ proof: any; publicSignals: string[] }> {
  const formattedInputs = formatForSnarkjs(circuitInputs);

  // Generate witness and proof
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    formattedInputs,
    wasmBuffer,
    zkeyBuffer
  );

  return { proof, publicSignals };
}

/**
 * Load circuit artifacts for given nullifiers/commitments count
 */
export function loadArtifacts(nullifiers: number, commitments: number): {
  wasm: Uint8Array;
  zkey: Uint8Array;
} {
  const artifact = getArtifact(nullifiers, commitments);
  return {
    wasm: artifact.wasm,
    zkey: artifact.zkey
  };
}

/**
 * Format snarkjs proof for on-chain verification
 */
export function formatProofForContract(proof: any): SnarkProof {
  return {
    a: {
      x: BigInt(proof.pi_a[0]),
      y: BigInt(proof.pi_a[1])
    },
    b: {
      x: [BigInt(proof.pi_b[0][1]), BigInt(proof.pi_b[0][0])],  // Note: swapped
      y: [BigInt(proof.pi_b[1][1]), BigInt(proof.pi_b[1][0])]   // Note: swapped
    },
    c: {
      x: BigInt(proof.pi_c[0]),
      y: BigInt(proof.pi_c[1])
    }
  };
}

/**
 * Format proof for Solidity struct
 */
export function proofToSolidity(proof: SnarkProof): {
  a: { x: string; y: string };
  b: { x: [string, string]; y: [string, string] };
  c: { x: string; y: string };
} {
  return {
    a: {
      x: proof.a.x.toString(),
      y: proof.a.y.toString()
    },
    b: {
      x: [proof.b.x[0].toString(), proof.b.x[1].toString()],
      y: [proof.b.y[0].toString(), proof.b.y[1].toString()]
    },
    c: {
      x: proof.c.x.toString(),
      y: proof.c.y.toString()
    }
  };
}

// ============ Full Transaction Builder ============

/**
 * Build a complete transaction with proof
 */
export async function buildTransaction(
  txInputs: TransactionInputs
): Promise<TransactionData> {
  // Build circuit inputs
  const circuitInputs = await buildCircuitInputs(txInputs);

  // Load artifacts
  const numInputs = txInputs.inputNotes.length;
  const numOutputs = txInputs.outputNotes.length;

  console.log(`Loading circuit artifacts for ${numInputs}x${numOutputs}...`);
  const { wasm, zkey } = loadArtifacts(numInputs, numOutputs);

  // Generate proof
  console.log("Generating ZK proof...");
  const { proof, publicSignals } = await generateProof(circuitInputs, wasm, zkey);

  // Format proof
  const formattedProof = formatProofForContract(proof);

  // Build transaction data
  const txData: TransactionData = {
    proof: formattedProof,
    merkleRoot: ethers.zeroPadValue(ethers.toBeHex(circuitInputs.merkleRoot), 32),
    nullifiers: circuitInputs.nullifiers.map(n =>
      ethers.zeroPadValue(ethers.toBeHex(n), 32)
    ),
    commitments: circuitInputs.commitmentsOut.map(c =>
      ethers.zeroPadValue(ethers.toBeHex(c), 32)
    ),
    boundParams: txInputs.boundParams,
    unshieldPreimage: txInputs.unshieldPreimage
  };

  return txData;
}

/**
 * Verify proof locally (for testing)
 */
export async function verifyProofLocally(
  proof: any,
  publicSignals: string[],
  vkey: any
): Promise<boolean> {
  return await snarkjs.groth16.verify(vkey, publicSignals, proof);
}
