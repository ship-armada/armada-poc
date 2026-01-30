/**
 * SDK Prover Module
 *
 * Provides proof generation using the SDK's Prover class:
 * - Initializes snarkjs for Groth16 proofs
 * - Generates transaction proofs
 * - Formats proofs for on-chain verification
 *
 * This replaces manual lib/prover.ts with SDK's proper implementation.
 */

import {
  Prover,
  SnarkJSGroth16,
  TransactionBatch,
  RailgunWallet,
  TXIDVersion,
  TransactionStructV2,
  RailgunVersionedSmartContracts,
  OutputType,
  getTokenDataERC20,
  UnshieldData,
} from '@railgun-community/engine';
import { Chain } from '@railgun-community/shared-models';
import { getEngine } from './init';
import { ContractTransaction } from 'ethers';

// ============ Types ============

export interface ProofProgress {
  progress: number;
  status: string;
}

export type ProofProgressCallback = (progress: ProofProgress) => void;

export interface TransferRecipient {
  railgunAddress: string;  // 0zk... format
  amount: bigint;
}

export interface UnshieldRecipient {
  ethAddress: string;      // 0x... format
  amount: bigint;
}

export interface ProvedTransactionResult {
  transactions: TransactionStructV2[];
  contractTransaction: ContractTransaction;
}

// ============ Prover Setup ============

let snarkjsInitialized = false;

/**
 * Initialize snarkjs for proof generation
 *
 * Must be called before generating proofs.
 * Uses dynamic import to load snarkjs.
 */
export async function initializeProver(): Promise<void> {
  if (snarkjsInitialized) {
    console.log('Prover already initialized');
    return;
  }

  console.log('Initializing prover with snarkjs...');

  // Dynamic import of snarkjs
  // @ts-ignore
  const snarkjs = await import('snarkjs');

  // Get engine and its prover
  const engine = getEngine();
  const prover = engine.prover;

  // Set snarkjs as the Groth16 implementation
  // Cast through unknown to handle type differences between snarkjs versions
  prover.setSnarkJSGroth16(snarkjs.groth16 as unknown as SnarkJSGroth16);

  snarkjsInitialized = true;
  console.log('Prover initialized successfully');
}

/**
 * Get the prover instance from the engine
 */
export function getProver(): Prover {
  const engine = getEngine();
  return engine.prover;
}

/**
 * Check if prover is initialized
 */
export function isProverInitialized(): boolean {
  return snarkjsInitialized;
}

// ============ Transaction Building ============

/**
 * Create a TransactionBatch for building transactions
 *
 * TransactionBatch handles:
 * - UTXO selection (spending notes)
 * - Change output calculation
 * - Circuit input generation
 *
 * @param chain - Chain to build transaction for
 * @param minGasPrice - Minimum gas price (0 for POC)
 */
export function createTransactionBatch(
  chain: Chain,
  minGasPrice: bigint = BigInt(0)
): TransactionBatch {
  return new TransactionBatch(chain, minGasPrice);
}

/**
 * Add a transfer output to transaction batch
 *
 * @param batch - Transaction batch
 * @param recipient - Recipient Railgun address
 * @param amount - Amount to transfer
 * @param tokenAddress - Token address for the transfer
 * @param showSenderAddress - Whether to reveal sender address to recipient
 * @param memoText - Optional memo text
 */
export function addTransferOutput(
  batch: TransactionBatch,
  recipient: string,
  amount: bigint,
  tokenAddress: string,
  showSenderAddress: boolean = false,
  memoText?: string
): void {
  const { TransactNote, decodeAddress } = require('@railgun-community/engine');

  const recipientAddressData = decodeAddress(recipient);
  const tokenData = getTokenDataERC20(tokenAddress);

  const note = TransactNote.createTransfer(
    recipientAddressData,
    undefined, // senderAddressData (optional - for showing sender)
    amount,
    tokenData,
    showSenderAddress,
    OutputType.Transfer,
    memoText
  );

  batch.addOutput(note);
}

/**
 * Add an unshield output to transaction batch
 *
 * Unshield converts private balance to public ERC20.
 *
 * @param batch - Transaction batch
 * @param toAddress - Ethereum address to receive tokens
 * @param amount - Amount to unshield
 * @param tokenAddress - Token to unshield
 */
export function addUnshieldOutput(
  batch: TransactionBatch,
  toAddress: string,
  amount: bigint,
  tokenAddress: string
): void {
  const tokenData = getTokenDataERC20(tokenAddress);
  const unshieldData: UnshieldData = {
    toAddress,
    value: amount,
    tokenData,
  };
  batch.addUnshieldData(unshieldData);
}

// ============ Proof Generation ============

/**
 * Generate proved transactions from a transaction batch
 *
 * This is the main proof generation function that:
 * 1. Selects UTXOs for spending
 * 2. Generates circuit inputs
 * 3. Creates Groth16 proofs
 * 4. Returns serialized transactions ready for on-chain submission
 *
 * @param batch - Transaction batch with outputs
 * @param wallet - Wallet to spend from
 * @param txidVersion - TXID version (V2 for our contracts)
 * @param encryptionKey - Wallet encryption key
 * @param progressCallback - Callback for progress updates
 */
export async function generateProvedTransactions(
  batch: TransactionBatch,
  wallet: RailgunWallet,
  txidVersion: TXIDVersion,
  encryptionKey: string,
  progressCallback?: ProofProgressCallback
): Promise<TransactionStructV2[]> {
  if (!snarkjsInitialized) {
    throw new Error('Prover not initialized. Call initializeProver() first.');
  }

  const prover = getProver();

  // Progress wrapper
  const wrappedCallback = (progress: number, status: string) => {
    if (progressCallback) {
      progressCallback({ progress, status });
    }
    console.log(`  [${Math.round(progress)}%] ${status}`);
  };

  console.log('Generating proved transactions...');

  // Generate transactions with proofs
  const { provedTransactions } = await batch.generateTransactions(
    prover,
    wallet,
    txidVersion,
    encryptionKey,
    wrappedCallback,
    false // shouldGeneratePreTransactionPOIs (not needed for POC)
  );

  console.log(`Generated ${provedTransactions.length} proved transaction(s)`);

  return provedTransactions as TransactionStructV2[];
}

/**
 * Generate contract transaction from proved transactions
 *
 * This creates the actual Ethereum transaction that can be
 * submitted to the RailgunSmartWallet contract.
 *
 * @param txidVersion - TXID version
 * @param provedTransactions - Array of proved transactions
 * @param chain - Chain to submit to
 */
export async function generateTransactCall(
  txidVersion: TXIDVersion,
  provedTransactions: TransactionStructV2[],
  chain: Chain
): Promise<ContractTransaction> {
  return RailgunVersionedSmartContracts.generateTransact(
    txidVersion,
    chain,
    provedTransactions
  );
}

// ============ High-Level Transaction Functions ============

/**
 * Create and prove a private transfer transaction
 *
 * This is a convenience function that handles the full flow:
 * 1. Create transaction batch
 * 2. Add transfer outputs
 * 3. Generate proofs
 * 4. Return contract transaction
 *
 * @param wallet - Wallet to spend from
 * @param chain - Chain configuration
 * @param tokenAddress - Token to transfer
 * @param recipients - Array of recipients with amounts
 * @param encryptionKey - Wallet encryption key
 * @param progressCallback - Progress callback
 */
export async function createTransferTransaction(
  wallet: RailgunWallet,
  chain: Chain,
  tokenAddress: string,
  recipients: TransferRecipient[],
  encryptionKey: string,
  progressCallback?: ProofProgressCallback
): Promise<ProvedTransactionResult> {
  // Create batch
  const batch = createTransactionBatch(chain);

  // Add outputs
  for (const recipient of recipients) {
    addTransferOutput(batch, recipient.railgunAddress, recipient.amount, tokenAddress);
  }

  // Generate proofs
  const transactions = await generateProvedTransactions(
    batch,
    wallet,
    TXIDVersion.V2_PoseidonMerkle,
    encryptionKey,
    progressCallback
  );

  // Generate contract call
  const contractTransaction = await generateTransactCall(
    TXIDVersion.V2_PoseidonMerkle,
    transactions,
    chain
  );

  return {
    transactions,
    contractTransaction,
  };
}

/**
 * Create and prove an unshield transaction
 *
 * Unshield converts private balance to public ERC20.
 *
 * @param wallet - Wallet to spend from
 * @param chain - Chain configuration
 * @param tokenAddress - Token to unshield
 * @param toAddress - Ethereum address to receive tokens
 * @param amount - Amount to unshield
 * @param encryptionKey - Wallet encryption key
 * @param progressCallback - Progress callback
 */
export async function createUnshieldTransaction(
  wallet: RailgunWallet,
  chain: Chain,
  tokenAddress: string,
  toAddress: string,
  amount: bigint,
  encryptionKey: string,
  progressCallback?: ProofProgressCallback
): Promise<ProvedTransactionResult> {
  // Create batch
  const batch = createTransactionBatch(chain);

  // Add unshield output
  addUnshieldOutput(batch, toAddress, amount, tokenAddress);

  // Generate proofs
  const transactions = await generateProvedTransactions(
    batch,
    wallet,
    TXIDVersion.V2_PoseidonMerkle,
    encryptionKey,
    progressCallback
  );

  // Generate contract call
  const contractTransaction = await generateTransactCall(
    TXIDVersion.V2_PoseidonMerkle,
    transactions,
    chain
  );

  return {
    transactions,
    contractTransaction,
  };
}

// ============ Proof Verification ============

/**
 * Verify a proof locally (for testing)
 *
 * @param proof - Groth16 proof
 * @param publicSignals - Public signals
 * @param vkey - Verification key
 */
export async function verifyProofLocally(
  proof: any,
  publicSignals: string[],
  vkey: any
): Promise<boolean> {
  // @ts-ignore
  const snarkjs = await import('snarkjs');
  return snarkjs.groth16.verify(vkey, publicSignals, proof);
}

// ============ Utility Functions ============

/**
 * Format proof for display
 */
export function formatProof(proof: any): string {
  return JSON.stringify({
    a: proof.pi_a?.slice(0, 2),
    b: proof.pi_b?.slice(0, 2),
    c: proof.pi_c?.slice(0, 2),
  }, null, 2);
}
