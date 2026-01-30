/**
 * SDK Transfer Module
 *
 * High-level API for private transfers using the SDK:
 * - Private transfers between Railgun addresses
 * - Unshield (withdraw to public address)
 * - Balance checking and UTXO management
 * - Transaction submission
 *
 * This replaces manual lib/transfer.ts with SDK's proper implementation.
 */

import {
  RailgunWallet,
  TXIDVersion,
  TransactionStructV2,
  RailgunVersionedSmartContracts,
  TokenBalances,
  getTokenDataERC20,
  getTokenDataHash,
} from '@railgun-community/engine';
import { Chain } from '@railgun-community/shared-models';
import { ethers, ContractTransaction, Signer, Provider } from 'ethers';
import { getEngine } from './init';
import {
  initializeProver,
  isProverInitialized,
  createTransactionBatch,
  addTransferOutput,
  addUnshieldOutput,
  generateProvedTransactions,
  generateTransactCall,
  ProofProgressCallback,
} from './prover';
import { getWalletBalances, scanWalletBalances } from './network';
import { DEFAULT_ENCRYPTION_KEY } from './wallet';

// ============ Types ============

export interface TransferRequest {
  /** Sender's Railgun wallet */
  wallet: RailgunWallet;
  /** Chain to transfer on */
  chain: Chain;
  /** Token address to transfer */
  tokenAddress: string;
  /** Recipient's Railgun address (0zk...) */
  recipientAddress: string;
  /** Amount to transfer (in base units) */
  amount: bigint;
  /** Wallet encryption key */
  encryptionKey?: string;
  /** Optional memo text */
  memoText?: string;
  /** Progress callback */
  progressCallback?: ProofProgressCallback;
}

export interface UnshieldRequest {
  /** Sender's Railgun wallet */
  wallet: RailgunWallet;
  /** Chain to unshield on */
  chain: Chain;
  /** Token address to unshield */
  tokenAddress: string;
  /** Recipient's Ethereum address (0x...) */
  recipientAddress: string;
  /** Amount to unshield (in base units) */
  amount: bigint;
  /** Wallet encryption key */
  encryptionKey?: string;
  /** Progress callback */
  progressCallback?: ProofProgressCallback;
}

export interface TransferResult {
  /** Proved transaction structs */
  transactions: TransactionStructV2[];
  /** Contract transaction ready for submission */
  contractTransaction: ContractTransaction;
  /** Nullifiers spent in this transaction */
  nullifiers: string[];
}

export interface BalanceInfo {
  /** Token address */
  tokenAddress: string;
  /** Token hash (used internally) */
  tokenHash: string;
  /** Total balance */
  balance: bigint;
  /** Number of UTXOs */
  utxoCount: number;
}

// ============ Balance Functions ============

/**
 * Get spendable balance for a token
 *
 * @param wallet - Railgun wallet
 * @param chain - Chain to check
 * @param tokenAddress - Token to check balance for
 * @returns Balance in base units, or 0 if no balance
 */
export async function getSpendableBalance(
  wallet: RailgunWallet,
  chain: Chain,
  tokenAddress: string
): Promise<bigint> {
  const balances = await wallet.getTokenBalances(
    TXIDVersion.V2_PoseidonMerkle,
    chain,
    true // onlySpendable
  );

  const tokenData = getTokenDataERC20(tokenAddress);
  const tokenHash = getTokenDataHash(tokenData);

  const balance = balances[tokenHash];
  return balance?.balance ?? BigInt(0);
}

/**
 * Get all token balances for a wallet
 *
 * @param wallet - Railgun wallet
 * @param chain - Chain to check
 * @returns Array of balance info for all tokens
 */
export async function getAllBalances(
  wallet: RailgunWallet,
  chain: Chain
): Promise<BalanceInfo[]> {
  const balances = await wallet.getTokenBalances(
    TXIDVersion.V2_PoseidonMerkle,
    chain,
    false // all balances, not just spendable
  );

  const result: BalanceInfo[] = [];

  for (const [tokenHash, treeBalance] of Object.entries(balances)) {
    result.push({
      tokenAddress: 'unknown', // Would need reverse lookup
      tokenHash,
      balance: treeBalance.balance,
      utxoCount: treeBalance.utxos.length,
    });
  }

  return result;
}

/**
 * Check if wallet has sufficient balance for a transfer
 *
 * @param wallet - Railgun wallet
 * @param chain - Chain
 * @param tokenAddress - Token to check
 * @param amount - Required amount
 * @returns true if sufficient balance
 */
export async function hasSufficientBalance(
  wallet: RailgunWallet,
  chain: Chain,
  tokenAddress: string,
  amount: bigint
): Promise<boolean> {
  const balance = await getSpendableBalance(wallet, chain, tokenAddress);
  return balance >= amount;
}

// ============ Transfer Functions ============

/**
 * Create and prove a private transfer transaction
 *
 * This is the main function for sending private transfers:
 * 1. Checks balance
 * 2. Selects UTXOs
 * 3. Generates ZK proof
 * 4. Returns transaction ready for submission
 *
 * @param request - Transfer request parameters
 * @returns TransferResult with proved transaction
 */
export async function createPrivateTransfer(
  request: TransferRequest
): Promise<TransferResult> {
  const {
    wallet,
    chain,
    tokenAddress,
    recipientAddress,
    amount,
    encryptionKey = DEFAULT_ENCRYPTION_KEY,
    memoText,
    progressCallback,
  } = request;

  // Ensure prover is initialized
  if (!isProverInitialized()) {
    console.log('Initializing prover...');
    await initializeProver();
  }

  // Check balance
  const balance = await getSpendableBalance(wallet, chain, tokenAddress);
  if (balance < amount) {
    throw new Error(
      `Insufficient balance: have ${balance}, need ${amount}`
    );
  }

  console.log(`Creating private transfer of ${amount} to ${recipientAddress.slice(0, 20)}...`);

  // Create transaction batch
  const batch = createTransactionBatch(chain);

  // Add transfer output
  addTransferOutput(batch, recipientAddress, amount, tokenAddress, false, memoText);

  // Generate proved transactions
  const transactions = await generateProvedTransactions(
    batch,
    wallet,
    TXIDVersion.V2_PoseidonMerkle,
    encryptionKey,
    progressCallback
  );

  // Generate contract transaction
  const contractTransaction = await generateTransactCall(
    TXIDVersion.V2_PoseidonMerkle,
    transactions,
    chain
  );

  // Extract nullifiers
  const nullifiers = transactions.flatMap(tx => tx.nullifiers as string[]);

  return {
    transactions,
    contractTransaction,
    nullifiers,
  };
}

/**
 * Create and prove an unshield transaction
 *
 * Unshield converts private balance to public ERC20:
 * 1. Checks balance
 * 2. Selects UTXOs
 * 3. Generates ZK proof
 * 4. Returns transaction ready for submission
 *
 * @param request - Unshield request parameters
 * @returns TransferResult with proved transaction
 */
export async function createUnshield(
  request: UnshieldRequest
): Promise<TransferResult> {
  const {
    wallet,
    chain,
    tokenAddress,
    recipientAddress,
    amount,
    encryptionKey = DEFAULT_ENCRYPTION_KEY,
    progressCallback,
  } = request;

  // Ensure prover is initialized
  if (!isProverInitialized()) {
    console.log('Initializing prover...');
    await initializeProver();
  }

  // Check balance
  const balance = await getSpendableBalance(wallet, chain, tokenAddress);
  if (balance < amount) {
    throw new Error(
      `Insufficient balance: have ${balance}, need ${amount}`
    );
  }

  console.log(`Creating unshield of ${amount} to ${recipientAddress}...`);

  // Create transaction batch
  const batch = createTransactionBatch(chain);

  // Add unshield output
  addUnshieldOutput(batch, recipientAddress, amount, tokenAddress);

  // Generate proved transactions
  const transactions = await generateProvedTransactions(
    batch,
    wallet,
    TXIDVersion.V2_PoseidonMerkle,
    encryptionKey,
    progressCallback
  );

  // Generate contract transaction
  const contractTransaction = await generateTransactCall(
    TXIDVersion.V2_PoseidonMerkle,
    transactions,
    chain
  );

  // Extract nullifiers
  const nullifiers = transactions.flatMap(tx => tx.nullifiers as string[]);

  return {
    transactions,
    contractTransaction,
    nullifiers,
  };
}

// ============ Transaction Submission ============

/**
 * Submit a transfer transaction to the blockchain
 *
 * @param signer - Ethers signer to submit with
 * @param result - Transfer result from createPrivateTransfer or createUnshield
 * @returns Transaction receipt
 */
export async function submitTransaction(
  signer: Signer,
  result: TransferResult
): Promise<ethers.TransactionReceipt | null> {
  const { contractTransaction } = result;

  console.log('Submitting transaction...');

  // Send the transaction
  const tx = await signer.sendTransaction({
    to: contractTransaction.to,
    data: contractTransaction.data,
  });

  console.log(`Transaction hash: ${tx.hash}`);

  // Wait for confirmation
  const receipt = await tx.wait();

  if (receipt) {
    console.log(`Transaction confirmed in block ${receipt.blockNumber}`);
  }

  return receipt;
}

/**
 * Estimate gas for a transfer transaction
 *
 * @param provider - Ethers provider
 * @param result - Transfer result
 * @returns Estimated gas
 */
export async function estimateGas(
  provider: Provider,
  result: TransferResult
): Promise<bigint> {
  const { contractTransaction } = result;

  const estimate = await provider.estimateGas({
    to: contractTransaction.to,
    data: contractTransaction.data,
  });

  return estimate;
}

// ============ Multi-Transfer Functions ============

/**
 * Create a batch transfer to multiple recipients
 *
 * @param wallet - Sender wallet
 * @param chain - Chain
 * @param tokenAddress - Token to transfer
 * @param recipients - Array of { address, amount } pairs
 * @param encryptionKey - Wallet encryption key
 * @param progressCallback - Progress callback
 */
export async function createBatchTransfer(
  wallet: RailgunWallet,
  chain: Chain,
  tokenAddress: string,
  recipients: Array<{ address: string; amount: bigint }>,
  encryptionKey: string = DEFAULT_ENCRYPTION_KEY,
  progressCallback?: ProofProgressCallback
): Promise<TransferResult> {
  // Ensure prover is initialized
  if (!isProverInitialized()) {
    await initializeProver();
  }

  // Calculate total amount
  const totalAmount = recipients.reduce((sum, r) => sum + r.amount, BigInt(0));

  // Check balance
  const balance = await getSpendableBalance(wallet, chain, tokenAddress);
  if (balance < totalAmount) {
    throw new Error(
      `Insufficient balance: have ${balance}, need ${totalAmount}`
    );
  }

  console.log(`Creating batch transfer of ${totalAmount} to ${recipients.length} recipients...`);

  // Create transaction batch
  const batch = createTransactionBatch(chain);

  // Add all transfer outputs
  for (const recipient of recipients) {
    addTransferOutput(batch, recipient.address, recipient.amount, tokenAddress);
  }

  // Generate proved transactions
  const transactions = await generateProvedTransactions(
    batch,
    wallet,
    TXIDVersion.V2_PoseidonMerkle,
    encryptionKey,
    progressCallback
  );

  // Generate contract transaction
  const contractTransaction = await generateTransactCall(
    TXIDVersion.V2_PoseidonMerkle,
    transactions,
    chain
  );

  const nullifiers = transactions.flatMap(tx => tx.nullifiers as string[]);

  return {
    transactions,
    contractTransaction,
    nullifiers,
  };
}

// ============ Utility Functions ============

/**
 * Format transfer result for display
 */
export function formatTransferResult(result: TransferResult): string {
  return `
Transfer Result:
  Transactions: ${result.transactions.length}
  Nullifiers: ${result.nullifiers.length}
    ${result.nullifiers.map(n => `- ${n.slice(0, 20)}...`).join('\n    ')}
  Contract TX: ${result.contractTransaction.to}
`;
}

/**
 * Parse USDC amount (6 decimals)
 */
export function parseUSDCAmount(amount: string): bigint {
  return ethers.parseUnits(amount, 6);
}

/**
 * Format USDC amount (6 decimals)
 */
export function formatUSDCAmount(amount: bigint): string {
  return ethers.formatUnits(amount, 6);
}

/**
 * Refresh wallet balances by rescanning merkle tree
 *
 * Call this after shields or transfers to update balances.
 *
 * @param wallet - Wallet to refresh
 * @param chain - Chain to scan
 */
export async function refreshBalances(
  wallet: RailgunWallet,
  chain: Chain
): Promise<void> {
  const engine = getEngine();
  await engine.fullRescanUTXOMerkletreesAndWallets(chain, [wallet.id]);
}
