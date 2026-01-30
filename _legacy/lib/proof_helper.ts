import { ethers } from "ethers";

/**
 * Proof Helper - Mock ZK proof generation for POC
 *
 * In real Railgun:
 * - Transfer proofs use Groth16 SNARKs proving:
 *   - Input nullifiers are valid (notes exist and aren't spent)
 *   - Output commitments are well-formed
 *   - Amounts balance (inputs = outputs + fee)
 * - Verification happens on-chain via Verifier contract
 *
 * For POC, we generate mock proofs that pass our SimpleShieldAdapter's checks.
 */

// ============ Types ============

export interface TransferProof {
  proof: string; // bytes - mock proof data
  inputNullifiers: string[]; // bytes32[] - nullifiers being spent
  outputCommitments: string[]; // bytes32[] - new commitments created
  publicInputs: string; // bytes - encoded public inputs
}

export interface UnshieldProof {
  proof: string;
  nullifier: string; // Single nullifier for the note being unshielded
  recipient: string; // Address receiving unshielded funds
  amount: bigint;
  publicInputs: string;
}

export interface MerkleProof {
  root: string; // bytes32 - merkle root
  pathElements: string[]; // bytes32[] - sibling hashes
  pathIndices: number[]; // uint8[] - left/right indicators
}

// ============ Mock Proof Generation ============

/**
 * Generate a mock transfer proof
 *
 * Real Railgun: Generates Groth16 proof circuit
 * POC: Creates dummy proof bytes that our contracts accept
 */
export function generateTransferProof(
  inputNullifiers: string[],
  outputCommitments: string[],
  inputAmounts: bigint[],
  outputAmounts: bigint[]
): TransferProof {
  // Verify amounts balance (simple check)
  const totalIn = inputAmounts.reduce((a, b) => a + b, 0n);
  const totalOut = outputAmounts.reduce((a, b) => a + b, 0n);

  if (totalIn !== totalOut) {
    throw new Error(
      `Transfer amounts don't balance: ${totalIn} in vs ${totalOut} out`
    );
  }

  // Generate mock proof (just random bytes for POC)
  // Real proof would be ~256 bytes of compressed curve points
  const proof = ethers.hexlify(ethers.randomBytes(256));

  // Encode public inputs
  const publicInputs = ethers.AbiCoder.defaultAbiCoder().encode(
    ["bytes32[]", "bytes32[]", "uint256[]", "uint256[]"],
    [inputNullifiers, outputCommitments, inputAmounts, outputAmounts]
  );

  return {
    proof,
    inputNullifiers,
    outputCommitments,
    publicInputs,
  };
}

/**
 * Generate a mock unshield proof
 *
 * Used when withdrawing from shielded pool back to public
 */
export function generateUnshieldProof(
  nullifier: string,
  recipient: string,
  amount: bigint
): UnshieldProof {
  const proof = ethers.hexlify(ethers.randomBytes(256));

  const publicInputs = ethers.AbiCoder.defaultAbiCoder().encode(
    ["bytes32", "address", "uint256"],
    [nullifier, recipient, amount]
  );

  return {
    proof,
    nullifier,
    recipient,
    amount,
    publicInputs,
  };
}

/**
 * Generate a deterministic mock proof (for testing)
 */
export function generateDeterministicProof(seed: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(`proof-${seed}`));
}

// ============ Merkle Tree Helpers ============

/**
 * Generate a mock merkle proof
 *
 * Real Railgun: Uses incremental merkle tree with Poseidon hashes
 * POC: Generates dummy path that our contracts accept
 */
export function generateMerkleProof(
  leafIndex: number,
  treeDepth: number = 16
): MerkleProof {
  const pathElements: string[] = [];
  const pathIndices: number[] = [];

  // Generate random sibling hashes
  for (let i = 0; i < treeDepth; i++) {
    pathElements.push(ethers.hexlify(ethers.randomBytes(32)));
    pathIndices.push((leafIndex >> i) & 1);
  }

  // Compute mock root (real would hash up the tree)
  const root = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes32[]", "uint8[]"],
      [pathElements, pathIndices]
    )
  );

  return {
    root,
    pathElements,
    pathIndices,
  };
}

/**
 * Compute merkle root from leaf and proof
 * (Simplified - real uses Poseidon hash)
 */
export function computeMerkleRoot(
  leaf: string,
  pathElements: string[],
  pathIndices: number[]
): string {
  let current = leaf;

  for (let i = 0; i < pathElements.length; i++) {
    if (pathIndices[i] === 0) {
      // Leaf is on the left
      current = ethers.keccak256(
        ethers.solidityPacked(["bytes32", "bytes32"], [current, pathElements[i]])
      );
    } else {
      // Leaf is on the right
      current = ethers.keccak256(
        ethers.solidityPacked(["bytes32", "bytes32"], [pathElements[i], current])
      );
    }
  }

  return current;
}

// ============ Encoding Helpers ============

/**
 * Encode transfer proof for contract call
 */
export function encodeTransferProofForContract(
  proof: TransferProof
): string {
  return ethers.AbiCoder.defaultAbiCoder().encode(
    ["bytes", "bytes32[]", "bytes32[]", "bytes"],
    [proof.proof, proof.inputNullifiers, proof.outputCommitments, proof.publicInputs]
  );
}

/**
 * Encode unshield proof for contract call
 */
export function encodeUnshieldProofForContract(
  proof: UnshieldProof
): string {
  return ethers.AbiCoder.defaultAbiCoder().encode(
    ["bytes", "bytes32", "address", "uint256", "bytes"],
    [proof.proof, proof.nullifier, proof.recipient, proof.amount, proof.publicInputs]
  );
}

// ============ Verification Helpers (Mock) ============

/**
 * Mock proof verification
 *
 * Real Railgun: Calls Verifier contract with proof + public inputs
 * POC: Always returns true (proofs aren't actually verified)
 */
export function verifyProof(proof: string, publicInputs: string): boolean {
  // In POC, all proofs are valid
  // Real implementation would verify SNARK
  return proof.length > 0 && publicInputs.length > 0;
}

/**
 * Check if nullifier format is valid
 */
export function isValidNullifier(nullifier: string): boolean {
  return (
    nullifier.startsWith("0x") &&
    nullifier.length === 66 && // 0x + 64 hex chars
    /^0x[0-9a-fA-F]{64}$/.test(nullifier)
  );
}

/**
 * Check if commitment format is valid
 */
export function isValidCommitment(commitment: string): boolean {
  return (
    commitment.startsWith("0x") &&
    commitment.length === 66 &&
    /^0x[0-9a-fA-F]{64}$/.test(commitment)
  );
}

// ============ Transfer/Unshield Request Builders ============

/**
 * Build a complete transfer request
 * (for private transfers within the shielded pool)
 */
export function buildTransferRequest(
  inputNotes: Array<{ commitment: string; randomness: string; amount: bigint }>,
  outputRecipients: Array<{ address: string; amount: bigint }>
): {
  proof: TransferProof;
  newNotes: Array<{ commitment: string; randomness: string; amount: bigint }>;
} {
  // Import dynamically to avoid circular dependency
  const { generateCommitment, generateNullifier } = require("./note_generator");

  // Generate nullifiers for inputs
  const inputNullifiers = inputNotes.map((note) =>
    generateNullifier(note.commitment, note.randomness)
  );

  // Generate new commitments for outputs
  const newNotes = outputRecipients.map(({ address, amount }) => {
    const note = generateCommitment(address, amount);
    return {
      commitment: note.commitment,
      randomness: note.randomness,
      amount,
    };
  });

  const outputCommitments = newNotes.map((n) => n.commitment);

  // Generate proof
  const proof = generateTransferProof(
    inputNullifiers,
    outputCommitments,
    inputNotes.map((n) => n.amount),
    outputRecipients.map((r) => r.amount)
  );

  return { proof, newNotes };
}

/**
 * Build a complete unshield request
 * (for withdrawing from shielded pool to public address)
 */
export function buildUnshieldRequest(
  note: { commitment: string; randomness: string; amount: bigint },
  recipient: string
): UnshieldProof {
  const { generateNullifier } = require("./note_generator");

  const nullifier = generateNullifier(note.commitment, note.randomness);

  return generateUnshieldProof(nullifier, recipient, note.amount);
}
