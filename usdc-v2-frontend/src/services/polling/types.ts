/**
 * Frontend Polling Service Types
 * 
 * Defines types and interfaces for frontend-managed chain polling.
 * This replaces backend-managed polling with a modular, resumable frontend implementation.
 */

import type { ChainKey, FlowType } from '@/shared/flowStages'
import type { ChainStage } from '@/types/flow'

/**
 * Flow polling status values
 */
export type FlowPollingStatus =
  | 'pending' // Flow is active (polling or waiting)
  | 'success' // Completed successfully, funds confirmed
  | 'tx_error' // Transaction error (chain rejected tx)
  | 'polling_error' // Polling infrastructure error (RPC unresponsive, rate limit)
  | 'polling_timeout' // Timeout before determining success/error
  | 'user_action_required' // User action required to proceed (e.g., forwarding registration)
  | 'cancelled' // User cancelled (can be resumed)

/**
 * Chain-level status values
 */
export type ChainStatusValue =
  | 'pending' // Chain polling not started or in progress
  | 'success' // Chain polling completed successfully
  | 'tx_error' // Transaction error detected on this chain
  | 'polling_error' // Polling infrastructure error on this chain
  | 'polling_timeout' // Polling timed out on this chain
  | 'user_action_required' // User action required to proceed (e.g., forwarding registration)
  | 'cancelled' // Chain polling was cancelled

/**
 * Chain status tracking
 * Tracks the status, errors, and timeouts for each chain in a flow
 */
export interface ChainStatus {
  /** Current status of this chain */
  status: ChainStatusValue
  /** Error type if status indicates an error */
  errorType?: 'tx_error' | 'polling_error' | 'polling_timeout' | 'user_action_required'
  /** Error message if status indicates an error */
  errorMessage?: string
  /** Error code if available (e.g., HTTP status code, RPC error code) */
  errorCode?: string | number
  /** Error category: network (connection issues) vs RPC (server-side errors) */
  errorCategory?: 'network' | 'rpc' | 'unknown'
  /** Whether error is recoverable (can be retried) */
  isRecoverable?: boolean
  /** Suggested recovery action */
  recoveryAction?: 'retry' | 'check_connection' | 'check_rpc_status' | 'contact_support' | 'none'
  /** Timestamp when error occurred (milliseconds since epoch) */
  errorOccurredAt?: number
  /** Timestamp when timeout occurred (milliseconds since epoch) */
  timeoutOccurredAt?: number
  /** Timestamp when chain polling completed successfully (milliseconds since epoch) */
  completedAt?: number
  /** Stages completed on this chain (stage names for resume logic) */
  completedStages: string[]
  /** All stages for this chain (client + polling stages in unified format) */
  stages?: ChainStage[]
  /** Retry count for this chain (number of retry attempts) */
  retryCount?: number
  /** Last retry timestamp (milliseconds since epoch) */
  lastRetryAt?: number
  /** Additional metadata for this chain */
  metadata?: Record<string, unknown>
}

/**
 * Polling state for a transaction flow
 * Persisted in StoredTransaction.pollingState for resumability
 */
export interface PollingState {
  /** Overall flow polling status */
  flowStatus: FlowPollingStatus
  /** Per-chain status tracking */
  chainStatus: {
    evm?: ChainStatus
    noble?: ChainStatus
    namada?: ChainStatus
  }
  /** Latest completed stage across all chains (for resume logic) */
  latestCompletedStage?: string
  /** Current chain being polled */
  currentChain?: ChainKey
  /** Flow type (deposit or payment) */
  flowType: FlowType
  /** Single source of truth: Progressive metadata that starts with initial fields and gets filled in as chains complete */
  metadata?: ChainPollMetadata
  /** Polling parameters per chain (for resumability) - NO metadata field */
  chainParams: {
    evm?: Omit<EvmPollParams, 'metadata'>
    noble?: Omit<NoblePollParams, 'metadata'>
    namada?: Omit<NamadaPollParams, 'metadata'>
  }
  /** Global timeout timestamp (milliseconds since epoch) */
  globalTimeoutAt?: number
  /** Flow-level error details (if applicable) */
  error?: {
    type: 'tx_error' | 'polling_error' | 'polling_timeout' | 'user_action_required'
    message: string
    occurredAt: number
    chain?: ChainKey
  }
  /** Timestamp when polling started (milliseconds since epoch) */
  startedAt: number
  /** Timestamp when polling last updated (milliseconds since epoch) */
  lastUpdatedAt: number
  /** Timestamp when polling was last active (for stale detection) */
  lastActiveAt?: number
}

/**
 * Chain poller interface
 * All chain pollers must implement this interface for modularity
 */
export interface ChainPoller {
  /**
   * Poll a chain for transaction events
   * 
   * @param params - Polling parameters including flow metadata
   * @returns Polling result with success status, metadata, and stages
   */
  poll(params: ChainPollParams): Promise<ChainPollResult>
}

/**
 * Base polling parameters (common to all chains)
 */
export interface BasePollParams {
  /** 
   * Flow ID (transaction ID)
   * TODO: Consider renaming to `txId` for clarity, as this represents the transaction ID, not a backend flowId.
   * This would require refactoring all polling implementations.
   */
  flowId: string
  /** Chain being polled */
  chain: ChainKey
  /** Flow type */
  flowType: FlowType
  /** Abort signal for cancellation */
  abortSignal?: AbortSignal
  /** Timeout in milliseconds */
  timeoutMs?: number
  /** Poll interval in milliseconds */
  intervalMs?: number
}

/**
 * Chain-specific polling parameters
 * Each chain poller defines its own parameter structure
 */
export interface ChainPollParams extends BasePollParams {
  /** Chain-specific metadata */
  metadata: ChainPollMetadata
}

/**
 * Chain polling metadata
 * Standardized metadata structure passed between chains
 */
export interface ChainPollMetadata {
  /** Actual chain key (e.g., 'sepolia', 'noble-testnet', 'namada-testnet') */
  chainKey?: string
  /** CCTP nonce (from EVM MessageSent or Noble DepositForBurn) */
  cctpNonce?: number
  /** Source domain ID (for CCTP) */
  sourceDomain?: number
  /** Destination domain ID (for CCTP) */
  destinationDomain?: number
  /** IBC packet sequence (from Noble or Namada) */
  packetSequence?: number
  /** Transaction hash */
  txHash?: string
  /** Block height */
  blockHeight?: number | string
  /** Start block/height for polling */
  startBlock?: number | bigint
  /** Start height for Tendermint chains */
  startHeight?: number
  /** Recipient address */
  recipient?: string
  /** Amount in base units */
  amountBaseUnits?: string
  /** Expected amount (for verification) */
  expectedAmountUusdc?: string
  /** Noble forwarding address */
  forwardingAddress?: string
  /** Namada receiver address */
  namadaReceiver?: string
  /** Message transmitter address (for EVM) */
  messageTransmitterAddress?: string
  /** USDC contract address (for EVM) */
  usdcAddress?: string
  /** Optional fallback address for Noble forwarding */
  fallback?: string
  /** Additional chain-specific metadata */
  [key: string]: unknown
}

/**
 * Chain polling result
 * Standardized result structure returned by all chain pollers
 */
export interface ChainPollResult {
  /** Whether polling was successful */
  success: boolean
  /** Whether the expected event was found */
  found: boolean
  /** Standardized metadata output (required for next chain) */
  metadata: ChainPollMetadata
  /** Error details if polling failed */
  error?: {
    type: 'tx_error' | 'polling_error' | 'polling_timeout' | 'user_action_required'
    message: string
    occurredAt: number
    code?: string | number
    category?: 'network' | 'rpc' | 'unknown'
    isRecoverable?: boolean
    recoveryAction?: 'retry' | 'check_connection' | 'check_rpc_status' | 'contact_support' | 'none'
  }
  /** Stages emitted during polling */
  stages: ChainStage[]
  /** Transaction hash if found */
  txHash?: string
  /** Block number/height if found */
  blockNumber?: number | bigint
  /** Height if found (for Tendermint chains) */
  height?: number
}

/**
 * EVM-specific polling parameters
 * NOTE: metadata field removed - metadata is now in PollingState.metadata
 */
export interface EvmPollParams extends BasePollParams {
  // metadata removed - use PollingState.metadata instead
}

/**
 * Noble-specific polling parameters
 * NOTE: metadata field removed - metadata is now in PollingState.metadata
 */
export interface NoblePollParams extends BasePollParams {
  // metadata removed - use PollingState.metadata instead
}

/**
 * Namada-specific polling parameters
 * NOTE: metadata field removed - metadata is now in PollingState.metadata
 */
export interface NamadaPollParams extends BasePollParams {
  // metadata removed - use PollingState.metadata instead
  /** Delay between block requests in milliseconds (for rate limiting) */
  blockRequestDelayMs?: number
}

/**
 * Chain timeout configuration
 * Loaded from chain config files
 */
export interface ChainTimeoutConfig {
  /** Deposit flow timeout in milliseconds */
  depositTimeoutMs: number
  /** Payment flow timeout in milliseconds */
  paymentTimeoutMs: number
}

/**
 * Global timeout configuration
 */
export interface GlobalTimeoutConfig {
  /** Global timeout multiplier (default 1.5x sum of chain timeouts) */
  multiplier?: number
  /** Minimum global timeout in milliseconds */
  minTimeoutMs?: number
  /** Maximum global timeout in milliseconds */
  maxTimeoutMs?: number
}

