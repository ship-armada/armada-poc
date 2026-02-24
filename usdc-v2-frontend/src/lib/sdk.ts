/**
 * Browser-Compatible SDK Wrapper
 *
 * This module provides browser-compatible SDK functionality for the frontend.
 * It uses the Railgun Wallet SDK with full wallet creation for balance scanning.
 */

import { ethers } from 'ethers'
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
} from '@railgun-community/wallet'
import {
  TXIDVersion,
  EVMGasType,
  type RailgunBalancesEvent,
  type RailgunERC20AmountRecipient,
  type TransactionGasDetails,
} from '@railgun-community/shared-models'
import {
  loadHubNetwork,
  getHubChainConfig,
  isHubNetworkLoaded,
} from './railgun/network'
import {
  isRelayerEnabled,
  getRelayerFee,
  getRelayerRailgunAddress,
  submitAndWaitForConfirmation,
} from '@/services/relayer'
import {
  getHubChainId,
  getChainToDomain as getChainToDomainMap,
  getRailgunNetworkNameString,
  getRelayerAddress as getDefaultRelayerAddress,
} from '@/config/networkConfig'

// ============ Types ============

export interface WalletState {
  mnemonic: string
  encryptionKey: string
  railgunAddress: string
  walletId: string
}

// Cache for wallet info to avoid recreating
const walletCache = new Map<
  string,
  { walletId: string; railgunAddress: string }
>()

// Balance update listeners
type BalanceUpdateListener = (event: RailgunBalancesEvent) => void
const balanceListeners = new Set<BalanceUpdateListener>()

// Set up the global balance update callback
setOnBalanceUpdateCallback((event: RailgunBalancesEvent) => {
  console.log('[sdk] Balance update event:', event)
  balanceListeners.forEach((listener) => listener(event))
})

/**
 * Register a balance update listener
 */
export function onBalanceUpdate(listener: BalanceUpdateListener): () => void {
  balanceListeners.add(listener)
  return () => balanceListeners.delete(listener)
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
  encryptionKey: string,
): Promise<{ walletId: string; railgunAddress: string }> {
  // Check cache first
  const cacheKey = mnemonic + encryptionKey
  const cached = walletCache.get(cacheKey)
  if (cached) {
    // Try to get the wallet to ensure it's still loaded
    try {
      walletForID(cached.walletId)
      console.log(
        '[sdk] Using cached wallet:',
        cached.walletId.slice(0, 16) + '...',
      )
      return cached
    } catch {
      // Wallet was unloaded, need to reload
      console.log('[sdk] Cached wallet not loaded, will reload')
    }
  }

  // Best-effort hub network load for balance scanning.
  // Wallet creation itself does not require the hub network.
  if (!isHubNetworkLoaded()) {
    console.log('[sdk] Loading hub network...')
    try {
      await loadHubNetwork()
    } catch (error) {
      console.warn(
        '[sdk] Failed to load hub network. Wallet will still be created; balances will be unavailable until the hub network loads.',
        error,
      )
    }
  }

  // Try to create wallet
  try {
    const walletInfo = await createRailgunWallet(
      encryptionKey,
      mnemonic,
      undefined, // creationBlockNumbers - not needed for fresh wallet
      0, // derivation index
    )

    const result = {
      walletId: walletInfo.id,
      railgunAddress: walletInfo.railgunAddress,
    }

    // Cache the result
    walletCache.set(cacheKey, result)

    console.log(
      '[sdk] Created Railgun wallet:',
      walletInfo.railgunAddress.slice(0, 30) + '...',
    )

    return result
  } catch (error) {
    // If wallet already exists, the SDK should return the existing wallet info
    // but just in case, we handle the error
    console.error('[sdk] Failed to create wallet:', error)
    throw error
  }
}

/**
 * Alias for backwards compatibility
 */
export async function generateRailgunAddressAsync(
  mnemonic: string,
  encryptionKey: string,
): Promise<{ walletId: string; railgunAddress: string }> {
  return createOrLoadWalletAsync(mnemonic, encryptionKey)
}

/**
 * Synchronous version that returns a placeholder if wallet not yet created
 * This is for backwards compatibility with existing code that expects sync
 */
export function generateRailgunAddress(mnemonic: string): string {
  // Check if we have a cached result
  for (const [key, value] of walletCache.entries()) {
    if (key.startsWith(mnemonic)) {
      return value.railgunAddress
    }
  }
  // Return placeholder - the async version should be called first
  return 'pending...'
}

/**
 * Generate a wallet ID from mnemonic (returns cached ID if available)
 */
export function generateWalletId(mnemonic: string): string | undefined {
  // Check cache first
  for (const [key, value] of walletCache.entries()) {
    if (key.startsWith(mnemonic)) {
      return value.walletId
    }
  }
  return undefined
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
  tokenAddress: string,
): Promise<bigint> {
  if (!walletId) {
    console.log('[sdk] No wallet ID provided for balance check')
    return 0n
  }

  if (!isHubNetworkLoaded()) {
    console.log('[sdk] Hub network not loaded, attempting to load')
    try {
      await loadHubNetwork()
    } catch (error) {
      console.warn(
        '[sdk] Hub network failed to load, skipping balance check',
        error,
      )
      return 0n
    }
  }

  try {
    const wallet = walletForID(walletId)

    // Get balance using SDK's balance method
    // We use TXIDVersion.V2_PoseidonMerkle since that's what our contracts support
    const balance = await balanceForERC20Token(
      TXIDVersion.V2_PoseidonMerkle,
      wallet,
      getRailgunNetworkNameString() as Parameters<typeof balanceForERC20Token>[2],
      tokenAddress,
      false, // onlySpendable - false to include all balances
    )

    console.log('[sdk] Shielded balance:', balance.toString())
    return balance
  } catch (error) {
    console.error('[sdk] Failed to get shielded balance:', error)
    return 0n
  }
}

/**
 * Trigger a balance refresh/scan for the wallet
 */
export async function refreshWalletBalances(walletId: string): Promise<void> {
  if (!walletId) return

  if (!isHubNetworkLoaded()) {
    try {
      await loadHubNetwork()
    } catch (error) {
      console.warn('[sdk] Hub network failed to load, skipping refresh', error)
      return
    }
  }

  try {
    const hubChain = getHubChainConfig()
    await refreshBalances(hubChain, [walletId])
    console.log('[sdk] Balance refresh triggered')
  } catch (error) {
    console.error('[sdk] Failed to refresh balances:', error)
  }
}

// ============ Utility Functions ============

/**
 * Format USDC amount for display (6 decimals)
 */
export function formatUSDC(amount: bigint): string {
  const divisor = 1_000_000n
  const whole = amount / divisor
  const fraction = amount % divisor
  const fractionStr = fraction.toString().padStart(6, '0')
  return `${whole}.${fractionStr.slice(0, 2)}`
}

/**
 * Parse USDC amount from user input
 */
export function parseUSDC(input: string): bigint {
  const parts = input.split('.')
  const whole = BigInt(parts[0] || '0')
  let fraction = parts[1] || '0'

  // Pad or truncate to 6 decimals
  fraction = fraction.padEnd(6, '0').slice(0, 6)

  return whole * 1_000_000n + BigInt(fraction)
}

/**
 * Truncate address for display
 */
export function truncateAddress(address: string, chars: number = 6): string {
  if (address.length <= chars * 2 + 3) return address
  return `${address.slice(0, chars)}...${address.slice(-chars)}`
}

// ============ Transfer & Unshield ============

/**
 * Progress callback type for proof generation
 * Progress is 0-1 (0% to 100%)
 */
export type ProofProgressCallback = (progress: number) => void

/** Stage callback for transaction lifecycle updates */
export type StageCallback = (stage: 'signing' | 'submitting' | 'confirming') => void

// Chain ID to CCTP domain mapping (from network config)
const CHAIN_TO_DOMAIN = getChainToDomainMap()

// Default relayer address (from network config)
const DEFAULT_RELAYER_ADDRESS = getDefaultRelayerAddress()

// PrivacyPool ABI for atomicCrossChainUnshield
const PRIVACY_POOL_ABI = [
  `function atomicCrossChainUnshield(
    (
      (
        (uint256 x, uint256 y) a,
        (uint256[2] x, uint256[2] y) b,
        (uint256 x, uint256 y) c
      ) proof,
      bytes32 merkleRoot,
      bytes32[] nullifiers,
      bytes32[] commitments,
      (
        uint16 treeNumber,
        uint72 minGasPrice,
        uint8 unshield,
        uint64 chainID,
        address adaptContract,
        bytes32 adaptParams,
        (
          bytes32[4] ciphertext,
          bytes32 blindedSenderViewingKey,
          bytes32 blindedReceiverViewingKey,
          bytes annotationData,
          bytes memo
        )[] commitmentCiphertext
      ) boundParams,
      (
        bytes32 npk,
        (uint8 tokenType, address tokenAddress, uint256 tokenSubID) token,
        uint120 value
      ) unshieldPreimage
    ) _transaction,
    uint32 destinationDomain,
    address finalRecipient,
    bytes32 destinationCaller,
    uint256 maxFee
  ) external returns (uint64)`,
]

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
  progressCallback?: ProofProgressCallback,
): Promise<{ txHash: string }> {
  console.log('[sdk] Starting private transfer...')
  console.log('[sdk]   Recipient:', recipientAddress)
  console.log('[sdk]   Amount:', amount.toString())

  // Ensure network is loaded - required for proof generation
  if (!isHubNetworkLoaded()) {
    console.log('[sdk] Loading hub network for proof generation...')
    await loadHubNetwork()
  }

  // Build the recipient array
  const erc20AmountRecipients: RailgunERC20AmountRecipient[] = [
    {
      tokenAddress,
      amount,
      recipientAddress, // 0zk... Railgun address
    },
  ]

  const networkName = getRailgunNetworkNameString() as Parameters<typeof generateTransferProof>[1]

  const useRelayer = isRelayerEnabled()
  let broadcasterFeeRecipient: RailgunERC20AmountRecipient | undefined
  if (useRelayer) {
    const relayerRailgunAddr = getRelayerRailgunAddress()
    if (relayerRailgunAddr?.startsWith('0zk')) {
      const fee = await getRelayerFee('transfer')
      broadcasterFeeRecipient = {
        tokenAddress,
        amount: fee,
        recipientAddress: relayerRailgunAddr,
      }
      console.log('[sdk] Including relayer fee in transfer proof:', fee.toString(), 'raw USDC')
    }
  }

  // Step 1: Generate proof
  console.log('[sdk] Generating transfer proof (this may take 20-30 seconds)...')
  await generateTransferProof(
    TXIDVersion.V2_PoseidonMerkle,
    networkName,
    walletId,
    encryptionKey,
    false, // showSenderAddressToRecipient
    undefined, // memoText
    erc20AmountRecipients,
    [], // nftAmountRecipients
    broadcasterFeeRecipient,
    true, // sendWithPublicWallet — always true (relayer submits raw calldata)
    undefined, // overallBatchMinGasPrice
    (progress) => {
      // SDK provides progress as 0-100, convert to 0-1 for our callback
      console.log(`[sdk] Proof progress: ${Math.round(progress)}%`)
      progressCallback?.(progress / 100)
    },
  )

  console.log('[sdk] Proof generated, populating transaction...')

  // Step 2: Populate transaction
  // Gas details for local hardhat - use EIP-1559 (Type2) as required by Railgun SDK for Hardhat
  const gasDetails: TransactionGasDetails = {
    evmGasType: EVMGasType.Type2,
    gasEstimate: 2000000n,
    maxFeePerGas: 2000000000n, // 2 gwei
    maxPriorityFeePerGas: 1000000000n, // 1 gwei
  }

  const populateResult = await populateProvedTransfer(
    TXIDVersion.V2_PoseidonMerkle,
    networkName,
    walletId,
    false, // showSenderAddressToRecipient
    undefined, // memoText
    erc20AmountRecipients,
    [], // nftAmountRecipients
    broadcasterFeeRecipient,
    true, // sendWithPublicWallet
    undefined, // overallBatchMinGasPrice
    gasDetails,
  )

  console.log('[sdk] Transaction populated, submitting...')

  // Step 3: Submit transaction
  if (useRelayer) {
    // Submit via relayer — no MetaMask popup
    const txHash = await submitAndWaitForConfirmation({
      chainId: getHubChainId(),
      to: populateResult.transaction.to!,
      data: populateResult.transaction.data!,
    })
    console.log('[sdk] Transaction confirmed via relayer:', txHash)
    return { txHash }
  }

  // Fallback: submit via MetaMask
  if (!window.ethereum) {
    throw new Error('No wallet found')
  }

  const provider = new ethers.BrowserProvider(window.ethereum)
  const signer = await provider.getSigner()

  const txRequest = {
    to: populateResult.transaction.to,
    data: populateResult.transaction.data,
    value: populateResult.transaction.value ?? 0n,
    gasLimit: gasDetails.gasEstimate,
  }

  const tx = await signer.sendTransaction(txRequest)
  console.log('[sdk] Transaction submitted:', tx.hash)

  const receipt = await tx.wait(1)
  if (!receipt || receipt.status === 0) {
    throw new Error('Transfer transaction failed')
  }

  console.log('[sdk] Transaction confirmed in block:', receipt.blockNumber)

  return { txHash: tx.hash }
}

/**
 * Execute an unshield to a public Ethereum address (hub chain only)
 *
 * Converts private balance to public ERC20 tokens on the Hub chain.
 *
 * @param walletId - Sender's wallet ID
 * @param encryptionKey - Wallet encryption key
 * @param tokenAddress - Token to unshield (MockUSDC)
 * @param recipientAddress - Recipient's Ethereum address (0x...)
 * @param amount - Amount to unshield in base units
 * @param progressCallback - Callback for proof generation progress (0-1)
 * @param stageCallback - Callback for transaction stage updates
 * @returns Transaction hash
 */
export async function executeUnshield(
  walletId: string,
  encryptionKey: string,
  tokenAddress: string,
  recipientAddress: string,
  amount: bigint,
  progressCallback?: ProofProgressCallback,
  stageCallback?: StageCallback,
): Promise<{ txHash: string }> {
  console.log('[sdk] Starting unshield...')
  console.log('[sdk]   Recipient:', recipientAddress)
  console.log('[sdk]   Amount:', amount.toString())

  // Ensure network is loaded - required for proof generation
  if (!isHubNetworkLoaded()) {
    console.log('[sdk] Loading hub network for proof generation...')
    await loadHubNetwork()
  }

  // Build the recipient array
  const erc20AmountRecipients: RailgunERC20AmountRecipient[] = [
    {
      tokenAddress,
      amount,
      recipientAddress, // 0x... Ethereum address
    },
  ]

  const networkName = getRailgunNetworkNameString() as Parameters<typeof generateUnshieldProof>[1]

  const useRelayer = isRelayerEnabled()
  let broadcasterFeeRecipient: RailgunERC20AmountRecipient | undefined
  if (useRelayer) {
    const relayerRailgunAddr = getRelayerRailgunAddress()
    if (relayerRailgunAddr?.startsWith('0zk')) {
      const fee = await getRelayerFee('unshield')
      broadcasterFeeRecipient = {
        tokenAddress,
        amount: fee,
        recipientAddress: relayerRailgunAddr,
      }
      console.log('[sdk] Including relayer fee in unshield proof:', fee.toString(), 'raw USDC')
    }
  }

  // Step 1: Generate proof
  console.log('[sdk] Generating unshield proof (this may take 20-30 seconds)...')
  await generateUnshieldProof(
    TXIDVersion.V2_PoseidonMerkle,
    networkName,
    walletId,
    encryptionKey,
    erc20AmountRecipients,
    [], // nftAmountRecipients
    broadcasterFeeRecipient,
    true, // sendWithPublicWallet
    undefined, // overallBatchMinGasPrice
    (progress) => {
      console.log(`[sdk] Proof progress: ${Math.round(progress)}%`)
      progressCallback?.(progress / 100)
    },
  )

  console.log('[sdk] Proof generated, populating transaction...')

  // Step 2: Populate transaction
  const gasDetails: TransactionGasDetails = {
    evmGasType: EVMGasType.Type2,
    gasEstimate: 2000000n,
    maxFeePerGas: 2000000000n, // 2 gwei
    maxPriorityFeePerGas: 1000000000n, // 1 gwei
  }

  const populateResult = await populateProvedUnshield(
    TXIDVersion.V2_PoseidonMerkle,
    networkName,
    walletId,
    erc20AmountRecipients,
    [], // nftAmountRecipients
    broadcasterFeeRecipient,
    true, // sendWithPublicWallet
    undefined, // overallBatchMinGasPrice
    gasDetails,
  )

  console.log('[sdk] Transaction populated, submitting...')

  // Step 3: Submit transaction
  if (useRelayer) {
    stageCallback?.('submitting')
    const txHash = await submitAndWaitForConfirmation({
      chainId: getHubChainId(),
      to: populateResult.transaction.to!,
      data: populateResult.transaction.data!,
    })
    console.log('[sdk] Transaction confirmed via relayer:', txHash)
    return { txHash }
  }

  // Fallback: submit via MetaMask
  if (!window.ethereum) {
    throw new Error('No wallet found')
  }

  const provider = new ethers.BrowserProvider(window.ethereum)
  const signer = await provider.getSigner()

  const txRequest = {
    to: populateResult.transaction.to,
    data: populateResult.transaction.data,
    value: populateResult.transaction.value ?? 0n,
    gasLimit: gasDetails.gasEstimate,
  }

  stageCallback?.('signing')
  const tx = await signer.sendTransaction(txRequest)
  console.log('[sdk] Transaction submitted:', tx.hash)

  stageCallback?.('confirming')
  const receipt = await tx.wait(1)

  if (!receipt || receipt.status === 0) {
    throw new Error('Unshield transaction failed')
  }

  console.log('[sdk] Transaction confirmed in block:', receipt.blockNumber)

  return { txHash: tx.hash }
}

/**
 * Execute atomic cross-chain unshield to a client chain via PrivacyPool
 *
 * This is the native CCTP integration flow where the proof verification
 * and CCTP bridging happen atomically in a single transaction.
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
  progressCallback?: ProofProgressCallback,
): Promise<{ txHash: string }> {
  console.log('[sdk] Starting atomic cross-chain unshield via PrivacyPool...')
  console.log('[sdk]   PrivacyPool:', privacyPoolAddress)
  console.log('[sdk]   Amount:', amount.toString())
  console.log('[sdk]   Destination Chain:', destinationChainId)
  console.log('[sdk]   Final Recipient:', finalRecipient)

  // Convert chain ID to CCTP domain
  const destinationDomain = CHAIN_TO_DOMAIN[destinationChainId]
  if (!destinationDomain) {
    throw new Error(
      `Unknown destination chain ID: ${destinationChainId}. No CCTP domain mapping.`,
    )
  }
  console.log('[sdk]   Destination Domain:', destinationDomain)

  // Ensure network is loaded - required for proof generation
  if (!isHubNetworkLoaded()) {
    console.log('[sdk] Loading hub network for proof generation...')
    await loadHubNetwork()
  }

  // Build the recipient array - unshield to the PrivacyPool contract
  const erc20AmountRecipients: RailgunERC20AmountRecipient[] = [
    {
      tokenAddress,
      amount,
      recipientAddress: privacyPoolAddress, // Unshield to PrivacyPool
    },
  ]

  const networkName = getRailgunNetworkNameString() as Parameters<typeof generateUnshieldProof>[1]

  const useRelayer = isRelayerEnabled()
  let broadcasterFeeRecipient: RailgunERC20AmountRecipient | undefined
  if (useRelayer) {
    const relayerRailgunAddr = getRelayerRailgunAddress()
    if (relayerRailgunAddr?.startsWith('0zk')) {
      const fee = await getRelayerFee('crossChainUnshield')
      broadcasterFeeRecipient = {
        tokenAddress,
        amount: fee,
        recipientAddress: relayerRailgunAddr,
      }
      console.log(
        '[sdk] Including relayer fee in cross-chain unshield proof:',
        fee.toString(),
        'raw USDC',
      )
    }
  }

  // Step 1: Generate proof
  console.log('[sdk] Generating unshield proof (this may take 20-30 seconds)...')
  await generateUnshieldProof(
    TXIDVersion.V2_PoseidonMerkle,
    networkName,
    walletId,
    encryptionKey,
    erc20AmountRecipients,
    [], // nftAmountRecipients
    broadcasterFeeRecipient,
    true, // sendWithPublicWallet
    undefined, // overallBatchMinGasPrice
    (progress) => {
      console.log(`[sdk] Proof progress: ${Math.round(progress)}%`)
      progressCallback?.(progress / 100)
    },
  )

  console.log('[sdk] Proof generated, populating transaction...')

  // Step 2: Populate transaction (this gives us the transact() calldata)
  const gasDetails: TransactionGasDetails = {
    evmGasType: EVMGasType.Type2,
    gasEstimate: 3000000n, // Higher limit for proof verification + CCTP
    maxFeePerGas: 2000000000n,
    maxPriorityFeePerGas: 1000000000n,
  }

  const populateResult = await populateProvedUnshield(
    TXIDVersion.V2_PoseidonMerkle,
    networkName,
    walletId,
    erc20AmountRecipients,
    [], // nftAmountRecipients
    broadcasterFeeRecipient,
    true, // sendWithPublicWallet
    undefined, // overallBatchMinGasPrice
    gasDetails,
  )

  console.log('[sdk] Transaction populated, extracting proof data...')

  // Step 3: Decode the transact() calldata to extract the Transaction struct
  const transactInterface = new ethers.Interface([
    'function transact((tuple(tuple(uint256 x, uint256 y) a, tuple(uint256[2] x, uint256[2] y) b, tuple(uint256 x, uint256 y) c) proof, bytes32 merkleRoot, bytes32[] nullifiers, bytes32[] commitments, tuple(uint16 treeNumber, uint72 minGasPrice, uint8 unshield, uint64 chainID, address adaptContract, bytes32 adaptParams, tuple(bytes32[4] ciphertext, bytes32 blindedSenderViewingKey, bytes32 blindedReceiverViewingKey, bytes annotationData, bytes memo)[] commitmentCiphertext) boundParams, tuple(bytes32 npk, tuple(uint8 tokenType, address tokenAddress, uint256 tokenSubID) token, uint120 value) unshieldPreimage)[] _transactions)',
  ])

  const txData = populateResult.transaction.data
  let decodedTransactions
  try {
    decodedTransactions = transactInterface.decodeFunctionData('transact', txData)
  } catch (err) {
    console.error('[sdk] Failed to decode transact calldata:', err)
    throw new Error('Failed to decode proof data from Railgun SDK')
  }

  // transact takes an array, we expect a single transaction
  const transactions = decodedTransactions[0]
  if (!transactions || transactions.length === 0) {
    throw new Error('No transaction found in proof data')
  }

  // ethers v6 returns frozen Result objects - we need to deep clone to make mutable
  const transactionRaw = transactions[0]
  const transaction = JSON.parse(
    JSON.stringify(transactionRaw, (_, v) =>
      typeof v === 'bigint' ? v.toString() : v,
    ),
  )

  // Convert string numbers back to BigInt where needed for the contract call
  const convertToBigInt = (obj: unknown): unknown => {
    if (obj === null || obj === undefined) return obj
    if (typeof obj === 'string' && /^\d+$/.test(obj) && obj.length > 15) {
      return BigInt(obj)
    }
    if (Array.isArray(obj)) {
      return obj.map(convertToBigInt)
    }
    if (typeof obj === 'object') {
      const result: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
        result[key] = convertToBigInt(value)
      }
      return result
    }
    return obj
  }

  const mutableTransaction = convertToBigInt(transaction)
  console.log('[sdk] Extracted Transaction struct from proof')

  // Step 4: Encode atomicCrossChainUnshield calldata
  const destinationCaller = ethers.zeroPadValue(DEFAULT_RELAYER_ADDRESS, 32)

  // Fetch CCTP maxFee for the cross-chain unshield
  let maxFee = 0n
  if (isRelayerEnabled()) {
    maxFee = await getRelayerFee('crossChainUnshield')
    console.log(`[sdk] CCTP maxFee for cross-chain unshield: ${maxFee.toString()} raw USDC`)
  }

  const privacyPoolInterface = new ethers.Interface(PRIVACY_POOL_ABI)
  const encodedCalldata = privacyPoolInterface.encodeFunctionData(
    'atomicCrossChainUnshield',
    [mutableTransaction, destinationDomain, finalRecipient, destinationCaller, maxFee],
  )

  // Step 5: Submit transaction
  if (useRelayer) {
    console.log('[sdk] Submitting cross-chain unshield via relayer...')
    const txHash = await submitAndWaitForConfirmation({
      chainId: getHubChainId(),
      to: privacyPoolAddress,
      data: encodedCalldata,
    })
    console.log('[sdk] Cross-chain unshield confirmed via relayer:', txHash)
    return { txHash }
  }

  // Fallback: submit via MetaMask
  if (!window.ethereum) {
    throw new Error('No wallet found')
  }

  const provider = new ethers.BrowserProvider(window.ethereum)
  const signer = await provider.getSigner()

  const privacyPool = new ethers.Contract(
    privacyPoolAddress,
    PRIVACY_POOL_ABI,
    signer,
  )

  const tx = await privacyPool.atomicCrossChainUnshield(
    mutableTransaction,
    destinationDomain,
    finalRecipient,
    destinationCaller,
    maxFee,
    { gasLimit: 3000000n },
  )

  console.log('[sdk] Transaction submitted:', tx.hash)

  const receipt = await tx.wait(1)
  if (!receipt || receipt.status === 0) {
    throw new Error('Cross-chain unshield transaction failed')
  }

  console.log('[sdk] Transaction confirmed in block:', receipt.blockNumber)

  return { txHash: tx.hash }
}

/**
 * Get CCTP domain for a chain ID
 */
export function getChainDomain(chainId: number): number | undefined {
  return CHAIN_TO_DOMAIN[chainId]
}
