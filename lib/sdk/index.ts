/**
 * SDK Module Exports
 *
 * Central export point for all SDK integration modules.
 * Use this for importing SDK functionality:
 *
 * import { initializeEngine, createWallet, createShieldRequest } from './lib/sdk';
 */

// Engine initialization
export {
  initializeEngine,
  shutdownEngine,
  getEngine,
  hasEngine,
  loadNetwork,
  clearDatabase,
} from './init';

// Chain configuration
export {
  HUB_CHAIN,
  CLIENT_CHAIN,
  HUB_RPC,
  CLIENT_RPC,
  DEPLOYMENT_BLOCK,
} from './chain-config';

// Wallet management
export {
  createWallet,
  loadWallet,
  getOrCreateWallet,
  getWalletKeys,
  getAddress,
  decodeAddress,
  generateMnemonic,
  validateMnemonic,
  saveWallet,
  loadWalletInfo,
  walletExists,
  listWallets,
  randomHex,
  formatWalletInfo,
  DEFAULT_ENCRYPTION_KEY,
  type WalletInfo,
  type WalletKeys,
} from './wallet';

// Shield operations
export {
  createShieldRequest,
  createShieldRequestBatch,
  generateShieldPrivateKey,
  deriveShieldPrivateKey,
  encodeShieldRequest,
  encodeShieldRequestSimple,
  decodeShieldPayload,
  calculateNpk,
  isValidRailgunAddress,
  isValidShieldPrivateKey,
  formatUSDC,
  parseUSDC,
  formatShieldRequest,
  SHIELD_SIGNATURE_MESSAGE,
  type ShieldInput,
  type ShieldResult,
  type ShieldBatchResult,
} from './shield';

// Network and Merkle Tree
export {
  loadDeployment,
  getRailgunProxyAddress,
  listDeployments,
  createProvider,
  createPollingProvider,
  loadNetworkIntoEngine,
  loadHubNetwork,
  scanMerkletree,
  getMerkleRoot,
  getMerkleProof,
  scanWalletBalances,
  getWalletBalances,
  type DeploymentInfo,
  type NetworkLoadResult,
} from './network';

// Prover and Transaction Building
export {
  initializeProver,
  getProver,
  isProverInitialized,
  createTransactionBatch,
  addTransferOutput,
  addUnshieldOutput,
  generateProvedTransactions,
  generateTransactCall,
  createTransferTransaction,
  createUnshieldTransaction,
  verifyProofLocally,
  formatProof,
  type ProofProgress,
  type ProofProgressCallback,
  type TransferRecipient,
  type UnshieldRecipient,
  type ProvedTransactionResult,
} from './prover';

// High-Level Transfer Operations
export {
  getSpendableBalance,
  getAllBalances,
  hasSufficientBalance,
  createPrivateTransfer,
  createUnshield,
  submitTransaction,
  estimateGas,
  createBatchTransfer,
  formatTransferResult,
  parseUSDCAmount,
  formatUSDCAmount,
  refreshBalances,
  type TransferRequest,
  type UnshieldRequest,
  type TransferResult,
  type BalanceInfo,
} from './transfer';
