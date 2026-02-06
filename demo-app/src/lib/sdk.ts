/**
 * Browser-Compatible SDK Wrapper
 *
 * This module provides browser-compatible SDK functionality for the demo app.
 * It uses the Railgun Wallet SDK with full wallet creation for balance scanning.
 */

import { ethers } from 'ethers';
import { type ChainConfig } from '../config';
import {
  createRailgunWallet,
  walletForID,
  refreshBalances,
  balanceForERC20Token,
  setOnBalanceUpdateCallback,
  generateTransferProof,
  populateProvedTransfer,
  generateUnshieldProof,
  populateProvedUnshield,
} from '@railgun-community/wallet';
import {
  TXIDVersion,
  type RailgunBalancesEvent,
  type RailgunERC20AmountRecipient,
  type TransactionGasDetails,
  EVMGasType,
} from '@railgun-community/shared-models';
import { loadHubNetwork, getHubChainConfig, isHubNetworkLoaded } from './railgun/network';

// ============ Types ============

export interface WalletState {
  mnemonic: string;
  encryptionKey: string;
  railgunAddress: string;
  walletId: string;
}

// Cache for wallet info to avoid recreating
const walletCache = new Map<string, { walletId: string; railgunAddress: string }>();

// Balance update listeners
type BalanceUpdateListener = (event: RailgunBalancesEvent) => void;
const balanceListeners = new Set<BalanceUpdateListener>();

// Set up the global balance update callback
setOnBalanceUpdateCallback((event: RailgunBalancesEvent) => {
  console.log('[sdk] Balance update event:', event);
  balanceListeners.forEach(listener => listener(event));
});

/**
 * Register a balance update listener
 */
export function onBalanceUpdate(listener: BalanceUpdateListener): () => void {
  balanceListeners.add(listener);
  return () => balanceListeners.delete(listener);
}

// ============ Wallet Creation ============

/**
 * Create or load a Railgun wallet from mnemonic
 *
 * This creates a full wallet that can scan balances and perform transfers.
 *
 * @param mnemonic - BIP39 mnemonic phrase
 * @param encryptionKey - Encryption key for wallet storage
 * @returns The wallet ID and Railgun address
 */
export async function createOrLoadWalletAsync(
  mnemonic: string,
  encryptionKey: string
): Promise<{ walletId: string; railgunAddress: string }> {
  // Check cache first
  const cacheKey = mnemonic + encryptionKey;
  const cached = walletCache.get(cacheKey);
  if (cached) {
    // Try to get the wallet to ensure it's still loaded
    try {
      walletForID(cached.walletId);
      console.log('[sdk] Using cached wallet:', cached.walletId.slice(0, 16) + '...');
      return cached;
    } catch {
      // Wallet was unloaded, need to reload
      console.log('[sdk] Cached wallet not loaded, will reload');
    }
  }

  // Best-effort hub network load for balance scanning.
  // Wallet creation itself does not require the hub network.
  if (!isHubNetworkLoaded()) {
    console.log('[sdk] Loading hub network...');
    try {
      await loadHubNetwork();
    } catch (error) {
      console.warn(
        '[sdk] Failed to load hub network. Wallet will still be created; balances will be unavailable until the hub network loads.',
        error
      );
    }
  }

  // Try to create wallet
  try {
    const walletInfo = await createRailgunWallet(
      encryptionKey,
      mnemonic,
      undefined, // creationBlockNumbers - not needed for fresh wallet
      0          // derivation index
    );

    const result = {
      walletId: walletInfo.id,
      railgunAddress: walletInfo.railgunAddress,
    };

    // Cache the result
    walletCache.set(cacheKey, result);

    console.log('[sdk] Created Railgun wallet:', walletInfo.railgunAddress.slice(0, 30) + '...');

    return result;
  } catch (error: any) {
    // If wallet already exists, the SDK should return the existing wallet info
    // but just in case, we handle the error
    console.error('[sdk] Failed to create wallet:', error);
    throw error;
  }
}

/**
 * Alias for backwards compatibility
 */
export async function generateRailgunAddressAsync(
  mnemonic: string,
  encryptionKey: string
): Promise<{ walletId: string; railgunAddress: string }> {
  return createOrLoadWalletAsync(mnemonic, encryptionKey);
}

/**
 * Synchronous version that returns a placeholder if wallet not yet created
 * This is for backwards compatibility with existing code that expects sync
 */
export function generateRailgunAddress(mnemonic: string): string {
  // Check if we have a cached result
  for (const [key, value] of walletCache.entries()) {
    if (key.startsWith(mnemonic)) {
      return value.railgunAddress;
    }
  }
  // Return placeholder - the async version should be called first
  return 'pending...';
}

/**
 * Generate a wallet ID from mnemonic (returns cached ID if available)
 */
export function generateWalletId(mnemonic: string): string | undefined {
  // Check cache first
  for (const [key, value] of walletCache.entries()) {
    if (key.startsWith(mnemonic)) {
      return value.walletId;
    }
  }
  return undefined;
}

// ============ Contract Interactions ============

// Contract ABIs (minimal for demo)
const MOCK_USDC_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
];

const FAUCET_ABI = [
  'function drip() external',
  'function USDC_AMOUNT() view returns (uint256)',
  'function ETH_AMOUNT() view returns (uint256)',
  'event Drip(address indexed recipient, uint256 usdcAmount, uint256 ethAmount)',
];

// ============ Privacy Pool ABIs (Native CCTP Integration) ============

// Default relayer address (first Hardhat account - used for local devnet)
// On public testnets, this should be configured per-chain
export const DEFAULT_RELAYER_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

// Relayer API URL (local devnet)
const RELAYER_API_URL = 'http://localhost:3001';

/**
 * Fetch the CCTP relay fee (maxFee) from the relayer API.
 * Returns 0n if the relayer is unavailable.
 */
async function fetchCctpRelayFee(): Promise<bigint> {
  try {
    const res = await fetch(`${RELAYER_API_URL}/fees`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return 0n;
    const data = await res.json();
    return BigInt(data.fees.crossChainShield);
  } catch {
    console.warn('[sdk] Relayer unavailable, using maxFee=0');
    return 0n;
  }
}

// PrivacyPoolClient ABI - used for cross-chain shield from client chains
export const PRIVACY_POOL_CLIENT_ABI = [
  'function crossChainShield(uint256 amount, uint256 maxFee, bytes32 npk, bytes32[3] calldata encryptedBundle, bytes32 shieldKey, bytes32 destinationCaller) external returns (uint64)',
  'event CrossChainShieldInitiated(address indexed sender, uint256 amount, bytes32 indexed npk, uint64 nonce)',
];

// Transaction struct definition (matching Globals.sol)
// Used for decoding Railgun SDK output and calling PrivacyPool
const TRANSACTION_STRUCT = `tuple(
  tuple(tuple(uint256 x, uint256 y) a, tuple(uint256[2] x, uint256[2] y) b, tuple(uint256 x, uint256 y) c) proof,
  bytes32 merkleRoot,
  bytes32[] nullifiers,
  bytes32[] commitments,
  tuple(uint16 treeNumber, uint72 minGasPrice, uint8 unshield, uint64 chainID, address adaptContract, bytes32 adaptParams, tuple(bytes32[4] ciphertext, bytes32 blindedSenderViewingKey, bytes32 blindedReceiverViewingKey, bytes annotationData, bytes memo)[] commitmentCiphertext) boundParams,
  tuple(bytes32 npk, tuple(uint8 tokenType, address tokenAddress, uint256 tokenSubID) token, uint120 value) unshieldPreimage
)`;

// PrivacyPool ABI - used for direct hub shielding and atomic cross-chain unshield
export const PRIVACY_POOL_ABI = [
  // Shield (local hub)
  'function shield((tuple(bytes32 npk, tuple(uint8 tokenType, address tokenAddress, uint256 tokenSubID) token, uint120 value) preimage, tuple(bytes32[3] encryptedBundle, bytes32 shieldKey) ciphertext)[] _shieldRequests) external',
  'event Shield(uint256 treeNumber, uint256 startPosition, tuple(bytes32 npk, tuple(uint8 tokenType, address tokenAddress, uint256 tokenSubID) token, uint120 value)[] commitments, tuple(bytes32[3] encryptedBundle, bytes32 shieldKey)[] shieldCiphertext, uint256[] fees)',
  // Transact (private transfer / unshield)
  `function transact(${TRANSACTION_STRUCT}[] _transactions) external`,
  // Atomic cross-chain unshield
  `function atomicCrossChainUnshield(${TRANSACTION_STRUCT} _transaction, uint32 destinationDomain, address finalRecipient, bytes32 destinationCaller) external returns (uint64)`,
  // View functions
  'function merkleRoot() view returns (bytes32)',
  'function treeNumber() view returns (uint256)',
  'function nextLeafIndex() view returns (uint256)',
];

// Legacy ABIs - kept for backwards compatibility
// Shield proxy ABI - used in deposit flow (old architecture)
export const CLIENT_SHIELD_PROXY_ABI = [
  'function shield(uint256 amount, bytes32 npk, bytes32[3] calldata encryptedBundle, bytes32 shieldKey) external returns (uint64)',
  'event ShieldInitiated(address indexed user, uint256 amount, bytes32 indexed npk, uint64 nonce)',
];

// RailgunSmartWallet ABI - used for direct hub shielding (old architecture)
export const RAILGUN_SMART_WALLET_ABI = [
  'function shield((tuple(bytes32 npk, tuple(uint8 tokenType, address tokenAddress, uint256 tokenSubID) token, uint120 value) preimage, tuple(bytes32[3] encryptedBundle, bytes32 shieldKey) ciphertext)[] _shieldRequests) external',
  'event Shield(uint256 treeNumber, uint256 startPosition, tuple(bytes32 npk, tuple(uint8 tokenType, address tokenAddress, uint256 tokenSubID) token, uint120 value)[] commitments, tuple(bytes32[3] encryptedBundle, bytes32 shieldKey)[] shieldCiphertext, uint256[] fees)',
];

/**
 * Get public USDC balance for an address on a chain
 */
export async function getPublicBalance(
  chainConfig: ChainConfig,
  address: string
): Promise<bigint> {
  if (!chainConfig.contracts?.mockUSDC) {
    console.warn(`No MockUSDC address for chain ${chainConfig.id}`);
    return 0n;
  }

  try {
    const provider = new ethers.JsonRpcProvider(chainConfig.rpcUrl);
    const usdc = new ethers.Contract(
      chainConfig.contracts.mockUSDC,
      MOCK_USDC_ABI,
      provider
    );

    const balance = await usdc.balanceOf(address);
    return balance;
  } catch (error) {
    console.error(`Failed to get balance on chain ${chainConfig.id}:`, error);
    return 0n;
  }
}

/**
 * Get native ETH balance for an address on a chain
 */
export async function getNativeBalance(
  chainConfig: ChainConfig,
  address: string
): Promise<bigint> {
  try {
    const provider = new ethers.JsonRpcProvider(chainConfig.rpcUrl);
    const balance = await provider.getBalance(address);
    return balance;
  } catch (error) {
    console.error(`Failed to get ETH balance on chain ${chainConfig.id}:`, error);
    return 0n;
  }
}

/**
 * Request tokens from faucet
 */
export async function requestFaucet(
  chainConfig: ChainConfig,
  signer: ethers.Signer
): Promise<{ txHash: string; usdcAmount: bigint; ethAmount: bigint }> {
  if (!chainConfig.contracts?.faucet) {
    throw new Error(`No faucet address for chain ${chainConfig.id}`);
  }

  const faucet = new ethers.Contract(
    chainConfig.contracts.faucet,
    FAUCET_ABI,
    signer
  );

  const tx = await faucet.drip();
  const receipt = await tx.wait();

  // Get amounts from constants
  const usdcAmount = await faucet.USDC_AMOUNT();
  const ethAmount = await faucet.ETH_AMOUNT();

  return {
    txHash: receipt.hash,
    usdcAmount,
    ethAmount,
  };
}

// ============ Shield Operations ============

/**
 * Check USDC allowance for spender
 */
export async function getUSDCAllowance(
  chainConfig: ChainConfig,
  owner: string,
  spender: string
): Promise<bigint> {
  if (!chainConfig.contracts?.mockUSDC) {
    return 0n;
  }

  const provider = new ethers.JsonRpcProvider(chainConfig.rpcUrl);
  const usdc = new ethers.Contract(
    chainConfig.contracts.mockUSDC,
    MOCK_USDC_ABI,
    provider
  );

  return usdc.allowance(owner, spender);
}

/**
 * Approve USDC spending for shield proxy
 */
export async function approveUSDC(
  chainConfig: ChainConfig,
  signer: ethers.Signer,
  spender: string,
  amount: bigint
): Promise<string> {
  if (!chainConfig.contracts?.mockUSDC) {
    throw new Error('No MockUSDC address for this chain');
  }

  const usdc = new ethers.Contract(
    chainConfig.contracts.mockUSDC,
    MOCK_USDC_ABI,
    signer
  );

  const tx = await usdc.approve(spender, amount);
  const receipt = await tx.wait();
  return receipt.hash;
}

/**
 * Execute cross-chain shield via PrivacyPoolClient
 *
 * This is the new native CCTP architecture where the client contract
 * directly integrates with CCTP to send shields to the Hub.
 *
 * @param chainConfig Chain configuration
 * @param signer Ethers signer
 * @param amount Amount to shield (in USDC base units)
 * @param npk Note public key
 * @param encryptedBundle Encrypted note data
 * @param shieldKey Shield key for decryption
 * @param relayerAddress Optional relayer address for destinationCaller (defaults to DEFAULT_RELAYER_ADDRESS)
 */
export async function executeCrossChainShield(
  chainConfig: ChainConfig,
  signer: ethers.Signer,
  amount: bigint,
  npk: string,
  encryptedBundle: [string, string, string],
  shieldKey: string,
  relayerAddress?: string
): Promise<{ txHash: string; nonce: bigint }> {
  if (!chainConfig.contracts?.privacyPoolClient) {
    throw new Error('No PrivacyPoolClient address for this chain');
  }

  const client = new ethers.Contract(
    chainConfig.contracts.privacyPoolClient,
    PRIVACY_POOL_CLIENT_ABI,
    signer
  );

  // Convert relayer address to bytes32 for destinationCaller
  // This restricts who can call receiveMessage() on the destination chain
  const relayer = relayerAddress || DEFAULT_RELAYER_ADDRESS;
  const destinationCaller = ethers.zeroPadValue(relayer, 32);

  // Fetch CCTP relay fee from the relayer API
  const maxFee = await fetchCctpRelayFee();
  console.log(`[sdk] Cross-chain shield: amount=${amount}, maxFee=${maxFee}`);

  const tx = await client.crossChainShield(amount, maxFee, npk, encryptedBundle, shieldKey, destinationCaller);
  const receipt = await tx.wait();

  // Parse the CrossChainShieldInitiated event to get nonce
  const iface = new ethers.Interface(PRIVACY_POOL_CLIENT_ABI);
  let nonce = 0n;

  for (const log of receipt.logs) {
    try {
      const parsed = iface.parseLog({ topics: log.topics as string[], data: log.data });
      if (parsed?.name === 'CrossChainShieldInitiated') {
        nonce = parsed.args.nonce;
        break;
      }
    } catch {
      // Not our event
    }
  }

  return {
    txHash: receipt.hash,
    nonce,
  };
}

/**
 * Execute shield via ClientShieldProxyV2 (legacy)
 * @deprecated Use executeCrossChainShield with PrivacyPoolClient instead
 */
export async function executeShield(
  chainConfig: ChainConfig,
  signer: ethers.Signer,
  amount: bigint,
  npk: string,
  encryptedBundle: [string, string, string],
  shieldKey: string
): Promise<{ txHash: string; nonce: bigint }> {
  // Native CCTP architecture - use PrivacyPoolClient
  if (!chainConfig.contracts?.privacyPoolClient) {
    throw new Error('No PrivacyPoolClient address for this chain');
  }

  return executeCrossChainShield(chainConfig, signer, amount, npk, encryptedBundle, shieldKey);
}

/**
 * Execute direct shield on hub chain via PrivacyPool
 *
 * This bypasses CCTP and calls the PrivacyPool contract directly.
 * Used when shielding from the hub chain itself.
 */
export async function executeDirectShield(
  chainConfig: ChainConfig,
  signer: ethers.Signer,
  amount: bigint,
  npk: string,
  encryptedBundle: [string, string, string],
  shieldKey: string
): Promise<{ txHash: string }> {
  // Native CCTP architecture - use PrivacyPool
  const contractAddress = chainConfig.contracts?.privacyPool;
  if (!contractAddress) {
    throw new Error('No PrivacyPool address for this chain');
  }
  if (!chainConfig.contracts?.mockUSDC) {
    throw new Error('No MockUSDC address for this chain');
  }

  // Both PrivacyPool and RailgunSmartWallet use the same shield() interface
  const pool = new ethers.Contract(
    contractAddress,
    PRIVACY_POOL_ABI,
    signer
  );

  // Build the ShieldRequest struct
  const shieldRequest = {
    preimage: {
      npk: npk,
      token: {
        tokenType: 0, // ERC20
        tokenAddress: chainConfig.contracts.mockUSDC,
        tokenSubID: 0n,
      },
      value: amount,
    },
    ciphertext: {
      encryptedBundle: encryptedBundle,
      shieldKey: shieldKey,
    },
  };

  const tx = await pool.shield([shieldRequest]);
  const receipt = await tx.wait();

  return {
    txHash: receipt.hash,
  };
}

// ============ Shielded Balance ============

/**
 * Get shielded balance for a wallet
 *
 * Uses the Railgun SDK's balance scanning infrastructure to get the
 * actual shielded balance for the wallet.
 *
 * @param walletId - The wallet ID (from createOrLoadWalletAsync)
 * @param tokenAddress - The token address (MockUSDC on hub chain)
 * @returns The shielded balance in token base units
 */
export async function getShieldedBalance(
  walletId: string,
  tokenAddress: string
): Promise<bigint> {
  if (!walletId) {
    console.log('[sdk] No wallet ID provided for balance check');
    return 0n;
  }

  if (!isHubNetworkLoaded()) {
    console.log('[sdk] Hub network not loaded, attempting to load');
    try {
      await loadHubNetwork();
    } catch (error) {
      console.warn('[sdk] Hub network failed to load, skipping balance check', error);
      return 0n;
    }
  }

  try {
    const wallet = walletForID(walletId);

    // Get balance using SDK's balance method
    // We use TXIDVersion.V2_PoseidonMerkle since that's what our contracts support
    const balance = await balanceForERC20Token(
      TXIDVersion.V2_PoseidonMerkle,
      wallet,
      'Hardhat' as any, // Use Hardhat as placeholder network name for our custom chain
      tokenAddress,
      false // onlySpendable - false to include all balances
    );

    console.log('[sdk] Shielded balance:', balance.toString());
    return balance;
  } catch (error) {
    console.error('[sdk] Failed to get shielded balance:', error);
    return 0n;
  }
}

/**
 * Trigger a balance refresh/scan for the wallet
 */
export async function refreshWalletBalances(walletId: string): Promise<void> {
  if (!walletId) return;

  if (!isHubNetworkLoaded()) {
    try {
      await loadHubNetwork();
    } catch (error) {
      console.warn('[sdk] Hub network failed to load, skipping refresh', error);
      return;
    }
  }

  try {
    const hubChain = getHubChainConfig();
    await refreshBalances(hubChain, [walletId]);
    console.log('[sdk] Balance refresh triggered');
  } catch (error) {
    console.error('[sdk] Failed to refresh balances:', error);
  }
}

// ============ Private Transfer ============

export type ProofProgressCallback = (progress: number) => void;

/**
 * Execute a private transfer to another Railgun address
 *
 * @param walletId - Sender's wallet ID
 * @param encryptionKey - Wallet encryption key
 * @param tokenAddress - Token to transfer (MockUSDC)
 * @param recipientAddress - Recipient's Railgun address (0zk...)
 * @param amount - Amount to transfer in base units
 * @param progressCallback - Callback for proof generation progress (0-1)
 * @returns Transaction hash
 */
export async function executePrivateTransfer(
  walletId: string,
  encryptionKey: string,
  tokenAddress: string,
  recipientAddress: string,
  amount: bigint,
  progressCallback?: ProofProgressCallback
): Promise<{ txHash: string }> {
  console.log('[sdk] Starting private transfer...');
  console.log('[sdk]   Recipient:', recipientAddress);
  console.log('[sdk]   Amount:', amount.toString());

  // Ensure network is loaded - required for proof generation
  if (!isHubNetworkLoaded()) {
    console.log('[sdk] Loading hub network for proof generation...');
    await loadHubNetwork();
  }

  // Build the recipient array
  const erc20AmountRecipients: RailgunERC20AmountRecipient[] = [
    {
      tokenAddress,
      amount,
      recipientAddress, // 0zk... Railgun address
    },
  ];

  // Use 'Hardhat' as the network name (matches our registered network)
  const networkName = 'Hardhat' as any;

  // Step 1: Generate proof
  console.log('[sdk] Generating transfer proof (this may take 20-30 seconds)...');
  await generateTransferProof(
    TXIDVersion.V2_PoseidonMerkle,
    networkName,
    walletId,
    encryptionKey,
    false,                    // showSenderAddressToRecipient
    undefined,                // memoText
    erc20AmountRecipients,
    [],                       // nftAmountRecipients
    undefined,                // broadcasterFeeERC20AmountRecipient
    true,                     // sendWithPublicWallet
    undefined,                // overallBatchMinGasPrice
    (progress) => {
      // SDK provides progress as 0-100, convert to 0-1 for our callback
      console.log(`[sdk] Proof progress: ${Math.round(progress)}%`);
      progressCallback?.(progress / 100);
    }
  );

  console.log('[sdk] Proof generated, populating transaction...');

  // Step 2: Populate transaction
  // Gas details for local hardhat - use EIP-1559 (Type2) as required by Railgun SDK for Hardhat
  const gasDetails: TransactionGasDetails = {
    evmGasType: EVMGasType.Type2,
    gasEstimate: 2000000n,
    maxFeePerGas: 2000000000n, // 2 gwei
    maxPriorityFeePerGas: 1000000000n, // 1 gwei
  };

  const populateResult = await populateProvedTransfer(
    TXIDVersion.V2_PoseidonMerkle,
    networkName,
    walletId,
    false,                    // showSenderAddressToRecipient
    undefined,                // memoText
    erc20AmountRecipients,
    [],                       // nftAmountRecipients
    undefined,                // broadcasterFeeERC20AmountRecipient
    true,                     // sendWithPublicWallet
    undefined,                // overallBatchMinGasPrice
    gasDetails
  );

  console.log('[sdk] Transaction populated, submitting...');
  console.log('[sdk] Transaction object:', populateResult.transaction);

  // Step 3: Submit transaction
  // Get signer from browser wallet
  if (!window.ethereum) {
    throw new Error('No wallet found');
  }

  const provider = new ethers.BrowserProvider(window.ethereum);
  const signer = await provider.getSigner();

  // The SDK returns a ContractTransaction which may have different field names
  // Ensure we have the right structure for ethers v6
  const txRequest = {
    to: populateResult.transaction.to,
    data: populateResult.transaction.data,
    value: populateResult.transaction.value ?? 0n,
    gasLimit: gasDetails.gasEstimate,
  };
  console.log('[sdk] Sending tx request:', txRequest);

  const tx = await signer.sendTransaction(txRequest);
  console.log('[sdk] Transaction submitted:', tx.hash);

  const receipt = await tx.wait();
  console.log('[sdk] Transaction confirmed in block:', receipt?.blockNumber);

  return { txHash: tx.hash };
}

// ============ Unshield ============

/**
 * Execute an unshield to a public Ethereum address
 *
 * Converts private balance to public ERC20 tokens on the Hub chain.
 *
 * @param walletId - Sender's wallet ID
 * @param encryptionKey - Wallet encryption key
 * @param tokenAddress - Token to unshield (MockUSDC)
 * @param recipientAddress - Recipient's Ethereum address (0x...)
 * @param amount - Amount to unshield in base units
 * @param progressCallback - Callback for proof generation progress (0-1)
 * @returns Transaction hash
 */
export async function executeUnshield(
  walletId: string,
  encryptionKey: string,
  tokenAddress: string,
  recipientAddress: string,
  amount: bigint,
  progressCallback?: ProofProgressCallback
): Promise<{ txHash: string }> {
  console.log('[sdk] Starting unshield...');
  console.log('[sdk]   Recipient:', recipientAddress);
  console.log('[sdk]   Amount:', amount.toString());

  // Ensure network is loaded - required for proof generation
  if (!isHubNetworkLoaded()) {
    console.log('[sdk] Loading hub network for proof generation...');
    await loadHubNetwork();
  }

  // Build the recipient array
  const erc20AmountRecipients: RailgunERC20AmountRecipient[] = [
    {
      tokenAddress,
      amount,
      recipientAddress, // 0x... Ethereum address
    },
  ];

  // Use 'Hardhat' as the network name (matches our registered network)
  const networkName = 'Hardhat' as any;

  // Step 1: Generate proof
  console.log('[sdk] Generating unshield proof (this may take 20-30 seconds)...');
  await generateUnshieldProof(
    TXIDVersion.V2_PoseidonMerkle,
    networkName,
    walletId,
    encryptionKey,
    erc20AmountRecipients,
    [],                       // nftAmountRecipients
    undefined,                // broadcasterFeeERC20AmountRecipient
    true,                     // sendWithPublicWallet
    undefined,                // overallBatchMinGasPrice
    (progress) => {
      // SDK provides progress as 0-100, convert to 0-1 for our callback
      console.log(`[sdk] Proof progress: ${Math.round(progress)}%`);
      progressCallback?.(progress / 100);
    }
  );

  console.log('[sdk] Proof generated, populating transaction...');

  // Step 2: Populate transaction
  // Gas details for local hardhat - use EIP-1559 (Type2) as required by Railgun SDK for Hardhat
  const gasDetails: TransactionGasDetails = {
    evmGasType: EVMGasType.Type2,
    gasEstimate: 2000000n,
    maxFeePerGas: 2000000000n, // 2 gwei
    maxPriorityFeePerGas: 1000000000n, // 1 gwei
  };

  const populateResult = await populateProvedUnshield(
    TXIDVersion.V2_PoseidonMerkle,
    networkName,
    walletId,
    erc20AmountRecipients,
    [],                       // nftAmountRecipients
    undefined,                // broadcasterFeeERC20AmountRecipient
    true,                     // sendWithPublicWallet
    undefined,                // overallBatchMinGasPrice
    gasDetails
  );

  console.log('[sdk] Transaction populated, submitting...');
  console.log('[sdk] Transaction object:', populateResult.transaction);

  // Step 3: Submit transaction
  // Get signer from browser wallet
  if (!window.ethereum) {
    throw new Error('No wallet found');
  }

  const provider = new ethers.BrowserProvider(window.ethereum);
  const signer = await provider.getSigner();

  // The SDK returns a ContractTransaction which may have different field names
  // Ensure we have the right structure for ethers v6
  const txRequest = {
    to: populateResult.transaction.to,
    data: populateResult.transaction.data,
    value: populateResult.transaction.value ?? 0n,
    gasLimit: gasDetails.gasEstimate,
  };
  console.log('[sdk] Sending tx request:', txRequest);

  const tx = await signer.sendTransaction(txRequest);
  console.log('[sdk] Transaction submitted:', tx.hash);

  // Don't wait for receipt - balance updates are detected via Railgun SDK polling
  // which is faster than BrowserProvider's default 4s polling interval
  tx.wait().then(receipt => {
    console.log('[sdk] Transaction confirmed in block:', receipt?.blockNumber);
  }).catch(err => {
    console.error('[sdk] Transaction failed:', err);
  });

  return { txHash: tx.hash };
}

// ============ Cross-Chain Unshield ============

// CCTP Domain ID mapping (must match CCTPDomains library in contracts)
const CHAIN_TO_DOMAIN: Record<number, number> = {
  31337: 100, // Hub
  31338: 101, // Client A
  31339: 102, // Client B
};

/**
 * Execute atomic cross-chain unshield to a client chain via PrivacyPool
 *
 * This is the native CCTP integration flow where the proof verification
 * and CCTP bridging happen atomically in a single transaction.
 *
 * Flow:
 *   1. Generate unshield proof with PrivacyPool as the recipient
 *   2. Decode the Transaction struct from the populated transact() call
 *   3. Call PrivacyPool.atomicCrossChainUnshield(transaction, domain, recipient)
 *   4. PrivacyPool verifies proof, burns USDC via CCTP
 *   5. CCTP relayer delivers message to PrivacyPoolClient
 *   6. PrivacyPoolClient forwards USDC to recipient
 *
 * @param walletId - Sender's wallet ID
 * @param encryptionKey - Wallet encryption key
 * @param tokenAddress - Token to unshield (MockUSDC)
 * @param privacyPoolAddress - Address of PrivacyPool on hub
 * @param amount - Amount to unshield in base units
 * @param destinationChainId - Target chain ID (will be converted to CCTP domain)
 * @param finalRecipient - Address to receive USDC on destination chain
 * @param progressCallback - Callback for proof generation progress (0-1)
 * @returns Transaction hash
 */
export async function executeUnshieldToClientChain(
  walletId: string,
  encryptionKey: string,
  tokenAddress: string,
  privacyPoolAddress: string,
  amount: bigint,
  destinationChainId: number,
  finalRecipient: string,
  progressCallback?: ProofProgressCallback
): Promise<{ txHash: string }> {
  console.log('[sdk] Starting atomic cross-chain unshield via PrivacyPool...');
  console.log('[sdk]   PrivacyPool:', privacyPoolAddress);
  console.log('[sdk]   Amount:', amount.toString());
  console.log('[sdk]   Destination Chain:', destinationChainId);
  console.log('[sdk]   Final Recipient:', finalRecipient);

  // Convert chain ID to CCTP domain
  const destinationDomain = CHAIN_TO_DOMAIN[destinationChainId];
  if (!destinationDomain) {
    throw new Error(`Unknown destination chain ID: ${destinationChainId}. No CCTP domain mapping.`);
  }
  console.log('[sdk]   Destination Domain:', destinationDomain);

  // Ensure network is loaded - required for proof generation
  if (!isHubNetworkLoaded()) {
    console.log('[sdk] Loading hub network for proof generation...');
    await loadHubNetwork();
  }

  // Build the recipient array - unshield to the PrivacyPool contract
  // The unshieldPreimage.npk will be set to PrivacyPool address
  // But we'll be calling atomicCrossChainUnshield which handles the CCTP routing
  const erc20AmountRecipients: RailgunERC20AmountRecipient[] = [
    {
      tokenAddress,
      amount,
      recipientAddress: privacyPoolAddress, // Unshield to PrivacyPool
    },
  ];

  // Use 'Hardhat' as the network name (matches our registered network)
  const networkName = 'Hardhat' as any;

  // Step 1: Generate proof
  console.log('[sdk] Generating unshield proof (this may take 20-30 seconds)...');
  await generateUnshieldProof(
    TXIDVersion.V2_PoseidonMerkle,
    networkName,
    walletId,
    encryptionKey,
    erc20AmountRecipients,
    [],                       // nftAmountRecipients
    undefined,                // broadcasterFeeERC20AmountRecipient
    true,                     // sendWithPublicWallet
    undefined,                // overallBatchMinGasPrice
    (progress) => {
      // SDK provides progress as 0-100, convert to 0-1 for our callback
      console.log(`[sdk] Proof progress: ${Math.round(progress)}%`);
      progressCallback?.(progress / 100);
    }
  );

  console.log('[sdk] Proof generated, populating transaction...');

  // Step 2: Populate transaction (this gives us the transact() calldata)
  const gasDetails: TransactionGasDetails = {
    evmGasType: EVMGasType.Type2,
    gasEstimate: 3000000n, // Higher limit for proof verification + CCTP
    maxFeePerGas: 2000000000n, // 2 gwei
    maxPriorityFeePerGas: 1000000000n, // 1 gwei
  };

  const populateResult = await populateProvedUnshield(
    TXIDVersion.V2_PoseidonMerkle,
    networkName,
    walletId,
    erc20AmountRecipients,
    [],                       // nftAmountRecipients
    undefined,                // broadcasterFeeERC20AmountRecipient
    true,                     // sendWithPublicWallet
    undefined,                // overallBatchMinGasPrice
    gasDetails
  );

  console.log('[sdk] Transaction populated, extracting proof data...');

  // Step 3: Decode the transact() calldata to extract the Transaction struct
  // The populateResult.transaction.data contains: transact(Transaction[])
  const transactInterface = new ethers.Interface([
    'function transact((tuple(tuple(uint256 x, uint256 y) a, tuple(uint256[2] x, uint256[2] y) b, tuple(uint256 x, uint256 y) c) proof, bytes32 merkleRoot, bytes32[] nullifiers, bytes32[] commitments, tuple(uint16 treeNumber, uint72 minGasPrice, uint8 unshield, uint64 chainID, address adaptContract, bytes32 adaptParams, tuple(bytes32[4] ciphertext, bytes32 blindedSenderViewingKey, bytes32 blindedReceiverViewingKey, bytes annotationData, bytes memo)[] commitmentCiphertext) boundParams, tuple(bytes32 npk, tuple(uint8 tokenType, address tokenAddress, uint256 tokenSubID) token, uint120 value) unshieldPreimage)[] _transactions)'
  ]);

  const txData = populateResult.transaction.data;
  let decodedTransactions;
  try {
    decodedTransactions = transactInterface.decodeFunctionData('transact', txData);
  } catch (err) {
    console.error('[sdk] Failed to decode transact calldata:', err);
    throw new Error('Failed to decode proof data from Railgun SDK');
  }

  // transact takes an array, we expect a single transaction
  const transactions = decodedTransactions[0];
  if (!transactions || transactions.length === 0) {
    throw new Error('No transaction found in proof data');
  }

  // ethers v6 returns frozen Result objects - we need to deep clone to make mutable
  // Using JSON parse/stringify handles the BigInt conversion via the Result's toJSON
  const transactionRaw = transactions[0];
  const transaction = JSON.parse(JSON.stringify(transactionRaw, (_, v) =>
    typeof v === 'bigint' ? v.toString() : v
  ));

  // Convert string numbers back to BigInt where needed for the contract call
  // The proof points and other large numbers need to be BigInt
  const convertToBigInt = (obj: unknown): unknown => {
    if (obj === null || obj === undefined) return obj;
    if (typeof obj === 'string' && /^\d+$/.test(obj) && obj.length > 15) {
      return BigInt(obj);
    }
    if (Array.isArray(obj)) {
      return obj.map(convertToBigInt);
    }
    if (typeof obj === 'object') {
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(obj)) {
        result[key] = convertToBigInt(value);
      }
      return result;
    }
    return obj;
  };

  const mutableTransaction = convertToBigInt(transaction);
  console.log('[sdk] Extracted Transaction struct from proof');

  // Step 4: Get signer from browser wallet
  if (!window.ethereum) {
    throw new Error('No wallet found');
  }

  const provider = new ethers.BrowserProvider(window.ethereum);
  const signer = await provider.getSigner();

  // Step 5: Call atomicCrossChainUnshield on PrivacyPool
  console.log('[sdk] Calling PrivacyPool.atomicCrossChainUnshield...');

  const privacyPool = new ethers.Contract(
    privacyPoolAddress,
    PRIVACY_POOL_ABI,
    signer
  );

  // Convert relayer address to bytes32 for destinationCaller
  // This restricts who can call receiveMessage() on the destination chain
  const destinationCaller = ethers.zeroPadValue(DEFAULT_RELAYER_ADDRESS, 32);

  const tx = await privacyPool.atomicCrossChainUnshield(
    mutableTransaction,
    destinationDomain,
    finalRecipient,
    destinationCaller,
    { gasLimit: 3000000n }
  );

  console.log('[sdk] Transaction submitted:', tx.hash);
  console.log('[sdk] Atomic cross-chain unshield initiated!');
  console.log('[sdk] User will receive tokens on client chain after CCTP relay');

  // Don't wait for receipt - balance updates are detected via Railgun SDK polling
  tx.wait().then((receipt: { blockNumber?: number } | null) => {
    console.log('[sdk] Transaction confirmed in block:', receipt?.blockNumber);
  }).catch((err: unknown) => {
    console.error('[sdk] Transaction failed:', err);
  });

  return { txHash: tx.hash };
}

// ============ Native CCTP Atomic Cross-Chain Unshield ============

/**
 * Execute atomic cross-chain unshield via PrivacyPool
 *
 * This is the new native CCTP architecture where unshield proof verification
 * and CCTP bridging happen in a single atomic transaction.
 *
 * Flow:
 *   1. User generates unshield proof via Railgun SDK
 *   2. User calls PrivacyPool.atomicCrossChainUnshield() with:
 *      - The transaction proof
 *      - Destination CCTP domain
 *      - Final recipient address on destination chain
 *   3. PrivacyPool verifies proof, nullifies inputs, sends CCTP message
 *   4. CCTP relayer delivers USDC to PrivacyPoolClient on destination
 *   5. PrivacyPoolClient forwards USDC to final recipient
 *
 * Benefits over legacy architecture:
 *   - Single atomic transaction (no callback complexity)
 *   - Direct CCTP integration (no proxy contract)
 *   - User specifies destination chain and recipient explicitly
 *
 * NOTE: This function requires the Railgun SDK to generate transaction proofs
 * compatible with the PrivacyPool contract. The proof format should match
 * the Transaction struct in the contract.
 *
 * @param hubChainConfig - Hub chain configuration (with privacyPool address)
 * @param signer - Ethers signer
 * @param transactionProof - The proof data from Railgun SDK
 * @param destinationChainId - Target chain ID
 * @param finalRecipient - Address to receive USDC on destination chain
 * @returns Transaction hash and CCTP nonce
 */
export async function executeAtomicCrossChainUnshield(
  hubChainConfig: ChainConfig,
  signer: ethers.Signer,
  transactionProof: any, // Transaction struct from Railgun SDK proof
  destinationChainId: number,
  finalRecipient: string
): Promise<{ txHash: string; nonce: bigint }> {
  const privacyPoolAddress = hubChainConfig.contracts?.privacyPool;
  if (!privacyPoolAddress) {
    throw new Error('No PrivacyPool address for hub chain. Native CCTP architecture not deployed.');
  }

  // Convert chain ID to CCTP domain ID
  const destinationDomain = CHAIN_TO_DOMAIN[destinationChainId];
  if (!destinationDomain) {
    throw new Error(`Unknown destination chain ID: ${destinationChainId}. No CCTP domain mapping.`);
  }

  console.log('[sdk] Executing atomic cross-chain unshield via PrivacyPool...');
  console.log('[sdk]   PrivacyPool:', privacyPoolAddress);
  console.log('[sdk]   Destination Chain:', destinationChainId);
  console.log('[sdk]   Destination Domain:', destinationDomain);
  console.log('[sdk]   Final Recipient:', finalRecipient);

  const privacyPool = new ethers.Contract(
    privacyPoolAddress,
    PRIVACY_POOL_ABI,
    signer
  );

  // Convert relayer address to bytes32 for destinationCaller
  // This restricts who can call receiveMessage() on the destination chain
  const destinationCaller = ethers.zeroPadValue(DEFAULT_RELAYER_ADDRESS, 32);

  const tx = await privacyPool.atomicCrossChainUnshield(
    transactionProof,
    destinationDomain,
    finalRecipient,
    destinationCaller,
    { gasLimit: 3000000n } // Higher limit for proof verification + CCTP
  );

  console.log('[sdk] Transaction submitted:', tx.hash);

  const receipt = await tx.wait();
  console.log('[sdk] Transaction confirmed in block:', receipt?.blockNumber);

  // Parse events to get CCTP nonce
  // The TransactModule emits events that include the CCTP nonce
  let nonce = 0n;
  // TODO: Parse CrossChainUnshield event to get nonce

  console.log('[sdk] Atomic cross-chain unshield initiated!');
  console.log('[sdk] User will receive tokens on client chain after CCTP relay');

  return {
    txHash: tx.hash,
    nonce,
  };
}

// ============ Diagnostics ============

/**
 * Get PrivacyPool contract state (for debugging balance scanning issues)
 */
export async function getRailgunContractState(): Promise<{
  nextLeafIndex: bigint;
  treeNumber: bigint;
  usdcBalance: bigint;
} | null> {
  try {
    // Load deployment to get contract addresses
    const hubRes = await fetch('/api/deployments/privacy-pool-hub.json');

    if (!hubRes.ok) {
      console.error('[sdk] Failed to load hub deployment file');
      return null;
    }

    const hubDeployment = await hubRes.json();

    const privacyPool = hubDeployment.contracts?.privacyPool;
    const mockUSDC = hubDeployment.cctp?.usdc;

    if (!privacyPool || !mockUSDC) {
      console.error('[sdk] Missing contract addresses');
      return null;
    }

    // Create provider for hub chain (port 8545 to match Railgun SDK's Hardhat network)
    const provider = new ethers.JsonRpcProvider('http://localhost:8545');

    // Query PrivacyPool contract state
    const poolABI = [
      'function nextLeafIndex() view returns (uint256)',
      'function treeNumber() view returns (uint256)',
    ];
    const pool = new ethers.Contract(privacyPool, poolABI, provider);

    // Query USDC balance of PrivacyPool contract
    const usdcABI = ['function balanceOf(address) view returns (uint256)'];
    const usdc = new ethers.Contract(mockUSDC, usdcABI, provider);

    const [nextLeafIndex, treeNumber, usdcBalance] = await Promise.all([
      pool.nextLeafIndex(),
      pool.treeNumber(),
      usdc.balanceOf(privacyPool),
    ]);

    console.log('[sdk] PrivacyPool contract state:', {
      nextLeafIndex: nextLeafIndex.toString(),
      treeNumber: treeNumber.toString(),
      usdcBalance: usdcBalance.toString(),
    });

    return {
      nextLeafIndex,
      treeNumber,
      usdcBalance,
    };
  } catch (error) {
    console.error('[sdk] Failed to get PrivacyPool contract state:', error);
    return null;
  }
}

// ============ Utility Functions ============

/**
 * Format USDC amount for display (6 decimals)
 */
export function formatUSDC(amount: bigint): string {
  const divisor = 1_000_000n;
  const whole = amount / divisor;
  const fraction = amount % divisor;
  const fractionStr = fraction.toString().padStart(6, '0');
  return `${whole}.${fractionStr.slice(0, 2)}`;
}

/**
 * Parse USDC amount from user input
 */
export function parseUSDC(input: string): bigint {
  const parts = input.split('.');
  const whole = BigInt(parts[0] || '0');
  let fraction = parts[1] || '0';

  // Pad or truncate to 6 decimals
  fraction = fraction.padEnd(6, '0').slice(0, 6);

  return whole * 1_000_000n + BigInt(fraction);
}

/**
 * Format ETH amount for display
 */
export function formatETH(amount: bigint): string {
  return ethers.formatEther(amount);
}

/**
 * Truncate address for display
 */
export function truncateAddress(address: string, chars: number = 6): string {
  if (address.length <= chars * 2 + 3) return address;
  return `${address.slice(0, chars)}...${address.slice(-chars)}`;
}
