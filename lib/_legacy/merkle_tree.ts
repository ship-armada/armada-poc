/**
 * Merkle Tree for Railgun Commitments
 *
 * Implements a sparse Merkle tree with Poseidon hashing.
 * Used to:
 * - Track commitments on-chain
 * - Generate Merkle proofs for spending notes
 */

import { ethers } from "ethers";
import { poseidonHash, initCrypto, SNARK_SCALAR_FIELD } from "./wallet";

// ============ Constants ============

export const TREE_DEPTH = 16;
export const TREE_SIZE = 2 ** TREE_DEPTH;  // 65536 leaves

// Zero value (from Railgun contract)
// ZERO_VALUE = uint256(keccak256("Railgun")) % SNARK_SCALAR_FIELD
export const ZERO_VALUE = BigInt(
  ethers.hexlify(ethers.keccak256(ethers.toUtf8Bytes("Railgun")))
) % SNARK_SCALAR_FIELD;

// ============ Types ============

export interface MerkleProof {
  leaf: bigint;
  leafIndex: number;
  pathElements: bigint[];
  root: bigint;
}

// ============ Merkle Tree Class ============

export class MerkleTree {
  private depth: number;
  private zeros: bigint[];
  private tree: Map<string, bigint>;  // level-index -> hash
  private leaves: bigint[];
  private nextLeafIndex: number;

  constructor(depth: number = TREE_DEPTH) {
    this.depth = depth;
    this.zeros = [];
    this.tree = new Map();
    this.leaves = [];
    this.nextLeafIndex = 0;

    // Precompute zero values for each level
    this.computeZeros();
  }

  /**
   * Compute zero values for each level
   * zeros[0] = ZERO_VALUE
   * zeros[i] = Poseidon(zeros[i-1], zeros[i-1])
   */
  private computeZeros(): void {
    this.zeros[0] = ZERO_VALUE;
    for (let i = 1; i <= this.depth; i++) {
      this.zeros[i] = poseidonHash([this.zeros[i - 1], this.zeros[i - 1]]);
    }
  }

  /**
   * Get the current root
   */
  get root(): bigint {
    return this.getNode(this.depth, 0);
  }

  /**
   * Get node at specific level and index
   */
  private getNode(level: number, index: number): bigint {
    const key = `${level}-${index}`;
    const node = this.tree.get(key);
    if (node !== undefined) {
      return node;
    }
    // Return zero value for this level
    return this.zeros[level];
  }

  /**
   * Set node at specific level and index
   */
  private setNode(level: number, index: number, value: bigint): void {
    const key = `${level}-${index}`;
    this.tree.set(key, value);
  }

  /**
   * Insert a leaf and update the tree
   */
  insert(leaf: bigint): number {
    const index = this.nextLeafIndex;
    if (index >= TREE_SIZE) {
      throw new Error("Tree is full");
    }

    // Store leaf
    this.leaves[index] = leaf;
    this.setNode(0, index, leaf);

    // Update path to root
    let currentIndex = index;
    let currentHash = leaf;

    for (let level = 0; level < this.depth; level++) {
      const isRight = currentIndex % 2 === 1;
      const siblingIndex = isRight ? currentIndex - 1 : currentIndex + 1;
      const sibling = this.getNode(level, siblingIndex);

      const left = isRight ? sibling : currentHash;
      const right = isRight ? currentHash : sibling;

      currentHash = poseidonHash([left, right]);
      currentIndex = Math.floor(currentIndex / 2);

      this.setNode(level + 1, currentIndex, currentHash);
    }

    this.nextLeafIndex++;
    return index;
  }

  /**
   * Insert multiple leaves
   */
  insertBatch(leaves: bigint[]): number[] {
    return leaves.map(leaf => this.insert(leaf));
  }

  /**
   * Get Merkle proof for a leaf
   */
  getProof(leafIndex: number): MerkleProof {
    if (leafIndex >= this.nextLeafIndex) {
      throw new Error(`Leaf index ${leafIndex} not found`);
    }

    const leaf = this.leaves[leafIndex];
    const pathElements: bigint[] = [];

    let currentIndex = leafIndex;
    for (let level = 0; level < this.depth; level++) {
      const isRight = currentIndex % 2 === 1;
      const siblingIndex = isRight ? currentIndex - 1 : currentIndex + 1;
      const sibling = this.getNode(level, siblingIndex);
      pathElements.push(sibling);
      currentIndex = Math.floor(currentIndex / 2);
    }

    return {
      leaf,
      leafIndex,
      pathElements,
      root: this.root
    };
  }

  /**
   * Verify a Merkle proof
   */
  static verifyProof(proof: MerkleProof): boolean {
    let currentHash = proof.leaf;
    let currentIndex = proof.leafIndex;

    for (let level = 0; level < proof.pathElements.length; level++) {
      const isRight = currentIndex % 2 === 1;
      const sibling = proof.pathElements[level];

      const left = isRight ? sibling : currentHash;
      const right = isRight ? currentHash : sibling;

      currentHash = poseidonHash([left, right]);
      currentIndex = Math.floor(currentIndex / 2);
    }

    return currentHash === proof.root;
  }

  /**
   * Get next available leaf index
   */
  getNextLeafIndex(): number {
    return this.nextLeafIndex;
  }

  /**
   * Get leaf at index
   */
  getLeaf(index: number): bigint | undefined {
    return this.leaves[index];
  }

  /**
   * Export tree state for serialization
   */
  export(): {
    depth: number;
    nextLeafIndex: number;
    leaves: string[];
    root: string;
  } {
    return {
      depth: this.depth,
      nextLeafIndex: this.nextLeafIndex,
      leaves: this.leaves.map(l => ethers.zeroPadValue(ethers.toBeHex(l), 32)),
      root: ethers.zeroPadValue(ethers.toBeHex(this.root), 32)
    };
  }

  /**
   * Import tree state
   */
  static import(data: {
    depth: number;
    nextLeafIndex: number;
    leaves: string[];
    root: string;
  }): MerkleTree {
    const tree = new MerkleTree(data.depth);
    for (const leafHex of data.leaves) {
      tree.insert(BigInt(leafHex));
    }
    return tree;
  }
}

// ============ On-chain Tree Sync ============

/**
 * Sync merkle tree state from on-chain contract
 * Reads Shield events to reconstruct tree
 */
export async function syncTreeFromContract(
  provider: ethers.Provider,
  railgunAddress: string,
  fromBlock: number = 0
): Promise<MerkleTree> {
  await initCrypto();

  const tree = new MerkleTree();

  // Shield event signature
  const shieldEventSig = "Shield(uint256,uint256,(bytes32,(uint8,address,uint256),uint120)[],(bytes32[3],bytes32)[],uint256[])";
  const shieldTopic = ethers.id(shieldEventSig);

  // Fetch all Shield events
  const logs = await provider.getLogs({
    address: railgunAddress,
    topics: [shieldTopic],
    fromBlock,
    toBlock: "latest"
  });

  // Parse and insert commitments
  const iface = new ethers.Interface([
    "event Shield(uint256 treeNumber, uint256 startPosition, tuple(bytes32 npk, tuple(uint8 tokenType, address tokenAddress, uint256 tokenSubID) token, uint120 value)[] commitments, tuple(bytes32[3] encryptedBundle, bytes32 shieldKey)[] shieldCiphertext, uint256[] fees)"
  ]);

  for (const log of logs) {
    try {
      const parsed = iface.parseLog({ topics: log.topics as string[], data: log.data });
      if (!parsed) continue;

      const commitments = parsed.args.commitments;

      for (const commitment of commitments) {
        // Compute commitment hash: Poseidon(npk, tokenId, value)
        const npk = BigInt(commitment.npk);
        const tokenAddress = commitment.token.tokenAddress;
        const tokenId = BigInt(tokenAddress);
        const value = BigInt(commitment.value);

        const commitmentHash = poseidonHash([npk, tokenId, value]);
        tree.insert(commitmentHash);
      }
    } catch (e) {
      console.error("Failed to parse Shield event:", e);
    }
  }

  return tree;
}

/**
 * Query current merkle root from contract
 */
export async function getOnChainRoot(
  provider: ethers.Provider,
  railgunAddress: string
): Promise<bigint> {
  const contract = new ethers.Contract(
    railgunAddress,
    ["function merkleRoot() view returns (bytes32)"],
    provider
  );

  const root = await contract.merkleRoot();
  return BigInt(root);
}

/**
 * Get on-chain next leaf index
 */
export async function getOnChainNextLeafIndex(
  provider: ethers.Provider,
  railgunAddress: string
): Promise<number> {
  const contract = new ethers.Contract(
    railgunAddress,
    ["function nextLeafIndex() view returns (uint256)"],
    provider
  );

  return Number(await contract.nextLeafIndex());
}
