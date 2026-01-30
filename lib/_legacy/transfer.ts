/**
 * Private Transfer - High-level API for private transfers
 *
 * This module provides a simple interface for:
 * - Creating private transfers between wallets
 * - Spending shielded notes
 * - Building and submitting transactions
 */

import { ethers } from "ethers";
import {
  RailgunWallet,
  Note,
  SpentNote,
  createWallet,
  initCrypto,
  createNote,
  computeNpk,
  getNoteCommitment,
  toBytes32,
  getTokenId
} from "./wallet";
import {
  MerkleTree,
  syncTreeFromContract,
  MerkleProof
} from "./merkle_tree";
import {
  buildTransaction,
  TransactionInputs,
  BoundParams,
  createMockCiphertext,
  TransactionData
} from "./prover";

// ============ Types ============

export interface TransferRequest {
  // Sender wallet
  senderWallet: RailgunWallet;

  // Notes to spend
  inputNotes: SpentNote[];

  // Transfer details
  recipientWallet: RailgunWallet;
  amount: bigint;
  tokenAddress: string;

  // Chain info
  chainId: bigint;
  treeNumber: number;
}

export interface UnshieldRequest {
  // Sender wallet (owner of notes to unshield)
  senderWallet: RailgunWallet;

  // Notes to spend
  inputNotes: SpentNote[];

  // Unshield details
  unshieldAmount: bigint;
  recipientAddress: string;  // EOA or contract to receive unshielded tokens
  tokenAddress: string;

  // Chain info
  chainId: bigint;
  treeNumber: number;

  // Unshield type: 1 = NORMAL (direct), 2 = REDIRECT (to adapt contract)
  unshieldType?: number;

  // Adapt contract for REDIRECT unshield (e.g., cross-chain bridge)
  adaptContract?: string;
  adaptParams?: string;
}

export interface UnshieldResult {
  transaction: TransactionData;
  changeNote: Note | null;  // Change note if any
  nullifiers: string[];
  unshieldValue: bigint;
  unshieldRecipient: string;
}

export interface TransferResult {
  transaction: TransactionData;
  outputNotes: Note[];  // Notes created (recipient + change)
  nullifiers: string[];
}

// ============ Transfer Functions ============

/**
 * Create a private transfer transaction
 *
 * @param request - Transfer request details
 * @param merkleTree - Current merkle tree state
 * @returns TransferResult with transaction data and output notes
 */
export async function createTransfer(
  request: TransferRequest,
  merkleTree: MerkleTree
): Promise<TransferResult> {
  await initCrypto();

  const {
    senderWallet,
    inputNotes,
    recipientWallet,
    amount,
    tokenAddress,
    chainId,
    treeNumber
  } = request;

  // Calculate total input value
  const totalIn = inputNotes.reduce((sum, n) => sum + n.value, 0n);

  // Validate we have enough funds
  if (totalIn < amount) {
    throw new Error(`Insufficient funds: have ${totalIn}, need ${amount}`);
  }

  // Calculate change
  const change = totalIn - amount;

  // Create output notes
  const outputNotes: Note[] = [];

  // 1. Recipient note
  const recipientNote = createNote(recipientWallet, tokenAddress, amount);
  outputNotes.push(recipientNote);

  // 2. Change note (back to sender) - only if there's change
  if (change > 0n) {
    const changeNote = createNote(senderWallet, tokenAddress, change);
    outputNotes.push(changeNote);
  }

  // Get merkle proofs for input notes
  const inputProofs: MerkleProof[] = inputNotes.map(note => {
    if (note.leafIndex === undefined) {
      throw new Error("Input note missing leafIndex");
    }
    return merkleTree.getProof(note.leafIndex);
  });

  // Create bound params
  const boundParams: BoundParams = {
    treeNumber,
    minGasPrice: 0n,  // Not enforcing gas price
    unshield: 0,  // NONE - private transfer, no unshield
    chainId,
    adaptContract: ethers.ZeroAddress,
    adaptParams: ethers.zeroPadValue("0x00", 32),
    commitmentCiphertext: outputNotes.map(() => createMockCiphertext())
  };

  // Build transaction inputs
  const txInputs: TransactionInputs = {
    inputNotes,
    inputProofs,
    outputNotes,
    boundParams,
    wallet: senderWallet
  };

  // Generate proof and build transaction
  console.log("Building transaction with ZK proof...");
  const transaction = await buildTransaction(txInputs);

  return {
    transaction,
    outputNotes,
    nullifiers: transaction.nullifiers
  };
}

/**
 * Create an unshield transaction (withdraw from shielded pool)
 *
 * @param request - Unshield request details
 * @param merkleTree - Current merkle tree state
 * @returns UnshieldResult with transaction data
 */
export async function createUnshield(
  request: UnshieldRequest,
  merkleTree: MerkleTree
): Promise<UnshieldResult> {
  await initCrypto();

  const {
    senderWallet,
    inputNotes,
    unshieldAmount,
    recipientAddress,
    tokenAddress,
    chainId,
    treeNumber,
    unshieldType = 1,  // Default: NORMAL
    adaptContract = ethers.ZeroAddress,
    adaptParams = ethers.zeroPadValue("0x00", 32)
  } = request;

  // Calculate total input value
  const totalIn = inputNotes.reduce((sum, n) => sum + n.value, 0n);

  // Validate we have enough funds
  if (totalIn < unshieldAmount) {
    throw new Error(`Insufficient funds: have ${totalIn}, need ${unshieldAmount}`);
  }

  // Calculate change
  const change = totalIn - unshieldAmount;

  // Create output notes
  // IMPORTANT: For the test circuits, we include the unshield value in valueOut
  // to satisfy the balance equation: sum(valueIn) = sum(valueOut)
  //
  // NOTE: The deployed verifier only has keys for 1x2, 2x2, 2x3, 8x4 circuits.
  // We need at least 2 outputs, so we always create a change note (even if zero-value).
  //
  // CRITICAL: The unshield output must be LAST in the array, as the contract checks:
  //   hash(unshieldPreimage) == commitments[commitments.length - 1]
  const outputNotes: Note[] = [];
  let changeNote: Note | null = null;

  // First output: change note (always created to ensure 1x2 circuit is used)
  // The deployed verifier doesn't have 1x1 key, only 1x2+
  changeNote = createNote(senderWallet, tokenAddress, change);
  outputNotes.push(changeNote);

  // Last output: unshield output (must be last for contract validation)
  // npk = recipient address, value = unshield amount
  const unshieldOutput: Note = {
    npk: BigInt(recipientAddress),
    token: getTokenId(tokenAddress),
    value: unshieldAmount,
    random: 0n  // Random not needed for unshield
  };
  outputNotes.push(unshieldOutput);

  // Get merkle proofs for input notes
  const inputProofs: MerkleProof[] = inputNotes.map(note => {
    if (note.leafIndex === undefined) {
      throw new Error("Input note missing leafIndex");
    }
    return merkleTree.getProof(note.leafIndex);
  });

  // Create bound params for unshield
  // For unshields, commitmentCiphertext array should have length = commitments - 1
  // since the unshield output (last output) doesn't have ciphertext
  // Only the change notes (first N-1 outputs) need ciphertext
  const ciphertextCount = outputNotes.length - 1;  // Exclude unshield output (last)
  const boundParams: BoundParams = {
    treeNumber,
    minGasPrice: 0n,
    unshield: unshieldType,  // 1 = NORMAL, 2 = REDIRECT
    chainId,
    adaptContract: unshieldType === 2 ? adaptContract : ethers.ZeroAddress,
    adaptParams: unshieldType === 2 ? adaptParams : ethers.zeroPadValue("0x00", 32),
    // Ciphertext for change notes only (not unshield output)
    commitmentCiphertext: Array(ciphertextCount).fill(null).map(() => createMockCiphertext())
  };

  // Build transaction inputs
  const txInputs: TransactionInputs = {
    inputNotes,
    inputProofs,
    outputNotes,
    boundParams,
    wallet: senderWallet,
    // Unshield preimage - this goes to the recipient
    unshieldPreimage: {
      npk: ethers.zeroPadValue(recipientAddress, 32),  // For unshield, npk is the recipient address
      tokenAddress,
      value: unshieldAmount
    }
  };

  // Generate proof and build transaction
  console.log("Building unshield transaction with ZK proof...");
  const transaction = await buildTransaction(txInputs);

  return {
    transaction,
    changeNote,
    nullifiers: transaction.nullifiers,
    unshieldValue: unshieldAmount,
    unshieldRecipient: recipientAddress
  };
}

// ABI for transact function (JSON format to avoid parsing issues)
const TRANSACT_ABI = [
  {
    "inputs": [
      {
        "components": [
          {
            "components": [
              {
                "components": [
                  { "name": "x", "type": "uint256" },
                  { "name": "y", "type": "uint256" }
                ],
                "name": "a",
                "type": "tuple"
              },
              {
                "components": [
                  { "name": "x", "type": "uint256[2]" },
                  { "name": "y", "type": "uint256[2]" }
                ],
                "name": "b",
                "type": "tuple"
              },
              {
                "components": [
                  { "name": "x", "type": "uint256" },
                  { "name": "y", "type": "uint256" }
                ],
                "name": "c",
                "type": "tuple"
              }
            ],
            "name": "proof",
            "type": "tuple"
          },
          { "name": "merkleRoot", "type": "bytes32" },
          { "name": "nullifiers", "type": "bytes32[]" },
          { "name": "commitments", "type": "bytes32[]" },
          {
            "components": [
              { "name": "treeNumber", "type": "uint16" },
              { "name": "minGasPrice", "type": "uint72" },
              { "name": "unshield", "type": "uint8" },
              { "name": "chainID", "type": "uint64" },
              { "name": "adaptContract", "type": "address" },
              { "name": "adaptParams", "type": "bytes32" },
              {
                "components": [
                  { "name": "ciphertext", "type": "bytes32[4]" },
                  { "name": "blindedSenderViewingKey", "type": "bytes32" },
                  { "name": "blindedReceiverViewingKey", "type": "bytes32" },
                  { "name": "annotationData", "type": "bytes" },
                  { "name": "memo", "type": "bytes" }
                ],
                "name": "commitmentCiphertext",
                "type": "tuple[]"
              }
            ],
            "name": "boundParams",
            "type": "tuple"
          },
          {
            "components": [
              { "name": "npk", "type": "bytes32" },
              {
                "components": [
                  { "name": "tokenType", "type": "uint8" },
                  { "name": "tokenAddress", "type": "address" },
                  { "name": "tokenSubID", "type": "uint256" }
                ],
                "name": "token",
                "type": "tuple"
              },
              { "name": "value", "type": "uint120" }
            ],
            "name": "unshieldPreimage",
            "type": "tuple"
          }
        ],
        "name": "_transactions",
        "type": "tuple[]"
      }
    ],
    "name": "transact",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      { "name": "", "type": "uint256" },
      { "name": "", "type": "bytes32" }
    ],
    "name": "nullifiers",
    "outputs": [{ "name": "", "type": "bool" }],
    "stateMutability": "view",
    "type": "function"
  }
];

/**
 * Submit a transfer transaction to the blockchain
 */
export async function submitTransfer(
  provider: ethers.Provider,
  signer: ethers.Signer,
  railgunAddress: string,
  transferResult: TransferResult
): Promise<ethers.TransactionReceipt | null> {
  const { transaction } = transferResult;

  // Format transaction for contract call
  const txStruct = formatTransactionForContract(transaction);

  // Get contract with JSON ABI
  const railgun = new ethers.Contract(
    railgunAddress,
    TRANSACT_ABI,
    signer
  );

  // Submit transaction
  console.log("Submitting transaction to RailgunSmartWallet...");
  const tx = await railgun.transact([txStruct]);
  const receipt = await tx.wait();

  return receipt;
}

/**
 * Submit an unshield transaction to the blockchain
 */
export async function submitUnshield(
  provider: ethers.Provider,
  signer: ethers.Signer,
  railgunAddress: string,
  unshieldResult: UnshieldResult
): Promise<ethers.TransactionReceipt | null> {
  const { transaction } = unshieldResult;

  // Format transaction for contract call
  const txStruct = formatTransactionForContract(transaction);

  // Get contract with JSON ABI
  const railgun = new ethers.Contract(
    railgunAddress,
    TRANSACT_ABI,
    signer
  );

  // Submit transaction
  console.log("Submitting unshield transaction to RailgunSmartWallet...");
  const tx = await railgun.transact([txStruct]);
  const receipt = await tx.wait();

  return receipt;
}

/**
 * Format transaction data for contract call
 */
function formatTransactionForContract(txData: TransactionData): any {
  return {
    proof: {
      a: { x: txData.proof.a.x.toString(), y: txData.proof.a.y.toString() },
      b: {
        x: [txData.proof.b.x[0].toString(), txData.proof.b.x[1].toString()],
        y: [txData.proof.b.y[0].toString(), txData.proof.b.y[1].toString()]
      },
      c: { x: txData.proof.c.x.toString(), y: txData.proof.c.y.toString() }
    },
    merkleRoot: txData.merkleRoot,
    nullifiers: txData.nullifiers,
    commitments: txData.commitments,
    boundParams: {
      treeNumber: txData.boundParams.treeNumber,
      minGasPrice: txData.boundParams.minGasPrice.toString(),
      unshield: txData.boundParams.unshield,
      chainID: txData.boundParams.chainId.toString(),
      adaptContract: txData.boundParams.adaptContract,
      adaptParams: txData.boundParams.adaptParams,
      commitmentCiphertext: txData.boundParams.commitmentCiphertext.map((ct: any) => ({
        ciphertext: ct.ciphertext,
        blindedSenderViewingKey: ct.blindedSenderViewingKey,
        blindedReceiverViewingKey: ct.blindedReceiverViewingKey,
        annotationData: ct.annotationData,
        memo: ct.memo
      }))
    },
    // Format unshield preimage - either from txData or empty
    unshieldPreimage: txData.unshieldPreimage ? {
      npk: txData.unshieldPreimage.npk,
      token: {
        tokenType: 0,  // ERC20
        tokenAddress: txData.unshieldPreimage.tokenAddress,
        tokenSubID: 0
      },
      value: txData.unshieldPreimage.value.toString()
    } : {
      npk: ethers.zeroPadValue("0x00", 32),
      token: {
        tokenType: 0,
        tokenAddress: ethers.ZeroAddress,
        tokenSubID: 0
      },
      value: 0
    }
  };
}

// ============ Utility Functions ============

/**
 * Find spendable notes for a wallet in the merkle tree
 * (POC: This is simplified - real implementation would decrypt notes)
 */
export function findSpendableNotes(
  wallet: RailgunWallet,
  notes: Note[],
  merkleTree: MerkleTree
): SpentNote[] {
  const spendable: SpentNote[] = [];

  for (let i = 0; i < notes.length; i++) {
    const note = notes[i];
    const commitment = getNoteCommitment(note);
    const leaf = merkleTree.getLeaf(i);

    if (leaf === commitment) {
      spendable.push({
        ...note,
        treeNumber: 0,
        leafIndex: i,
        pathElements: merkleTree.getProof(i).pathElements
      });
    }
  }

  return spendable;
}

/**
 * Create a SpentNote from a Note with merkle tree position
 */
export function noteToSpentNote(
  note: Note,
  leafIndex: number,
  merkleTree: MerkleTree
): SpentNote {
  return {
    ...note,
    treeNumber: 0,
    leafIndex,
    pathElements: merkleTree.getProof(leafIndex).pathElements
  };
}

// ============ Debug Helpers ============

/**
 * Print transaction summary
 */
export function printTransactionSummary(result: TransferResult): void {
  console.log("\n=== Transfer Transaction Summary ===");
  console.log(`Nullifiers: ${result.nullifiers.length}`);
  result.nullifiers.forEach((n, i) => console.log(`  [${i}] ${n}`));

  console.log(`\nOutput Commitments: ${result.transaction.commitments.length}`);
  result.transaction.commitments.forEach((c, i) => console.log(`  [${i}] ${c}`));

  console.log(`\nOutput Notes:`);
  result.outputNotes.forEach((note, i) => {
    console.log(`  [${i}] Value: ${note.value}, NPK: ${toBytes32(note.npk).slice(0, 20)}...`);
  });

  console.log(`\nMerkle Root: ${result.transaction.merkleRoot}`);
  console.log(`Chain ID: ${result.transaction.boundParams.chainId}`);
}
