/**
 * Transaction Types for Privacy Pool POC
 *
 * Simplified transaction model for EVM-only flows:
 * - Shield (direct on hub, cross-chain from client)
 * - Transfer (private 0zk -> 0zk)
 * - Unshield (direct on hub, cross-chain to client)
 */

// ============ Flow Types ============

/** The type of privacy pool operation */
export type FlowType = 'shield' | 'transfer' | 'unshield'

/** Which chain scope the operation involves */
export type ChainScope = 'hub' | 'client-a' | 'client-b'

/** Overall transaction status */
export type TxStatus =
  | 'pending' // In progress
  | 'success' // Completed successfully
  | 'error' // Failed with error
  | 'cancelled' // User cancelled or timeout

// ============ Stage Definitions ============

/** Stage status */
export type StageStatus = 'pending' | 'active' | 'confirmed' | 'error' | 'skipped'

/**
 * Individual stage in a transaction flow
 */
export interface TxStage {
  /** Stage identifier */
  id: string
  /** Human-readable label */
  label: string
  /** Current status */
  status: StageStatus
  /** Status message */
  message?: string
  /** Transaction hash if applicable */
  txHash?: string
  /** Block number when confirmed */
  blockNumber?: number
  /** Timestamp when stage completed */
  timestamp?: number
  /** Additional metadata */
  metadata?: Record<string, unknown>
}

// ============ Stage IDs by Flow Type ============

/**
 * Shield flow stages
 */
export const SHIELD_STAGES = {
  // Common stages
  APPROVAL_PENDING: 'approval_pending',
  APPROVAL_CONFIRMED: 'approval_confirmed',

  // Direct shield (hub)
  SHIELD_PENDING: 'shield_pending',
  SHIELD_SUBMITTED: 'shield_submitted',
  SHIELD_CONFIRMED: 'shield_confirmed',

  // Cross-chain shield (client -> hub via CCTP)
  CCTP_BURN_PENDING: 'cctp_burn_pending',
  CCTP_BURN_SUBMITTED: 'cctp_burn_submitted',
  CCTP_BURN_CONFIRMED: 'cctp_burn_confirmed',
  CCTP_ATTESTATION_PENDING: 'cctp_attestation_pending',
  CCTP_ATTESTATION_RECEIVED: 'cctp_attestation_received',
  CCTP_RELAY_PENDING: 'cctp_relay_pending',
  CCTP_MINT_CONFIRMED: 'cctp_mint_confirmed',

  // Completion
  BALANCE_UPDATING: 'balance_updating',
  COMPLETED: 'completed',
  FAILED: 'failed',
} as const

export type ShieldStageId = (typeof SHIELD_STAGES)[keyof typeof SHIELD_STAGES]

/**
 * Transfer flow stages (private transfer)
 */
export const TRANSFER_STAGES = {
  PROOF_GENERATING: 'proof_generating',
  TRANSFER_PENDING: 'transfer_pending',
  TRANSFER_SUBMITTED: 'transfer_submitted',
  TRANSFER_CONFIRMED: 'transfer_confirmed',
  BALANCE_UPDATING: 'balance_updating',
  COMPLETED: 'completed',
  FAILED: 'failed',
} as const

export type TransferStageId = (typeof TRANSFER_STAGES)[keyof typeof TRANSFER_STAGES]

/**
 * Unshield flow stages
 */
export const UNSHIELD_STAGES = {
  // Common stages
  PROOF_GENERATING: 'proof_generating',
  UNSHIELD_PENDING: 'unshield_pending',
  UNSHIELD_SUBMITTED: 'unshield_submitted',
  UNSHIELD_CONFIRMED: 'unshield_confirmed',

  // Cross-chain unshield (hub -> client via CCTP)
  CCTP_ATTESTATION_PENDING: 'cctp_attestation_pending',
  CCTP_ATTESTATION_RECEIVED: 'cctp_attestation_received',
  CCTP_RELAY_PENDING: 'cctp_relay_pending',
  CCTP_MINT_CONFIRMED: 'cctp_mint_confirmed',

  // Completion
  BALANCE_UPDATING: 'balance_updating',
  COMPLETED: 'completed',
  FAILED: 'failed',
} as const

export type UnshieldStageId = (typeof UNSHIELD_STAGES)[keyof typeof UNSHIELD_STAGES]

/** Union of all stage IDs */
export type StageId = ShieldStageId | TransferStageId | UnshieldStageId

// ============ Expected Stage Progression ============

/**
 * Get expected stages for a flow type
 */
export function getExpectedStages(
  flowType: FlowType,
  isCrossChain: boolean,
): string[] {
  switch (flowType) {
    case 'shield':
      if (isCrossChain) {
        return [
          SHIELD_STAGES.APPROVAL_PENDING,
          SHIELD_STAGES.APPROVAL_CONFIRMED,
          SHIELD_STAGES.CCTP_BURN_PENDING,
          SHIELD_STAGES.CCTP_BURN_SUBMITTED,
          SHIELD_STAGES.CCTP_BURN_CONFIRMED,
          SHIELD_STAGES.CCTP_ATTESTATION_PENDING,
          SHIELD_STAGES.CCTP_ATTESTATION_RECEIVED,
          SHIELD_STAGES.CCTP_RELAY_PENDING,
          SHIELD_STAGES.CCTP_MINT_CONFIRMED,
          SHIELD_STAGES.BALANCE_UPDATING,
          SHIELD_STAGES.COMPLETED,
        ]
      }
      return [
        SHIELD_STAGES.APPROVAL_PENDING,
        SHIELD_STAGES.APPROVAL_CONFIRMED,
        SHIELD_STAGES.SHIELD_PENDING,
        SHIELD_STAGES.SHIELD_SUBMITTED,
        SHIELD_STAGES.SHIELD_CONFIRMED,
        SHIELD_STAGES.BALANCE_UPDATING,
        SHIELD_STAGES.COMPLETED,
      ]

    case 'transfer':
      return [
        TRANSFER_STAGES.PROOF_GENERATING,
        TRANSFER_STAGES.TRANSFER_PENDING,
        TRANSFER_STAGES.TRANSFER_SUBMITTED,
        TRANSFER_STAGES.TRANSFER_CONFIRMED,
        TRANSFER_STAGES.BALANCE_UPDATING,
        TRANSFER_STAGES.COMPLETED,
      ]

    case 'unshield':
      if (isCrossChain) {
        return [
          UNSHIELD_STAGES.PROOF_GENERATING,
          UNSHIELD_STAGES.UNSHIELD_PENDING,
          UNSHIELD_STAGES.UNSHIELD_SUBMITTED,
          UNSHIELD_STAGES.UNSHIELD_CONFIRMED,
          UNSHIELD_STAGES.CCTP_ATTESTATION_PENDING,
          UNSHIELD_STAGES.CCTP_ATTESTATION_RECEIVED,
          UNSHIELD_STAGES.CCTP_RELAY_PENDING,
          UNSHIELD_STAGES.CCTP_MINT_CONFIRMED,
          UNSHIELD_STAGES.COMPLETED,
        ]
      }
      return [
        UNSHIELD_STAGES.PROOF_GENERATING,
        UNSHIELD_STAGES.UNSHIELD_PENDING,
        UNSHIELD_STAGES.UNSHIELD_SUBMITTED,
        UNSHIELD_STAGES.UNSHIELD_CONFIRMED,
        UNSHIELD_STAGES.BALANCE_UPDATING,
        UNSHIELD_STAGES.COMPLETED,
      ]

    default:
      return []
  }
}

/**
 * Get human-readable label for a stage
 */
export function getStageLabel(stageId: string): string {
  const labels: Record<string, string> = {
    // Shield stages
    [SHIELD_STAGES.APPROVAL_PENDING]: 'Approving USDC',
    [SHIELD_STAGES.APPROVAL_CONFIRMED]: 'Approval confirmed',
    [SHIELD_STAGES.SHIELD_PENDING]: 'Signing shield',
    [SHIELD_STAGES.SHIELD_SUBMITTED]: 'Shield submitted',
    [SHIELD_STAGES.SHIELD_CONFIRMED]: 'Shield confirmed',
    [SHIELD_STAGES.CCTP_BURN_PENDING]: 'Signing CCTP transfer',
    [SHIELD_STAGES.CCTP_BURN_SUBMITTED]: 'CCTP transfer submitted',
    [SHIELD_STAGES.CCTP_BURN_CONFIRMED]: 'Burn confirmed',
    [SHIELD_STAGES.CCTP_ATTESTATION_PENDING]: 'Waiting for attestation',
    [SHIELD_STAGES.CCTP_ATTESTATION_RECEIVED]: 'Attestation received',
    [SHIELD_STAGES.CCTP_RELAY_PENDING]: 'Relaying to destination',
    [SHIELD_STAGES.CCTP_MINT_CONFIRMED]: 'USDC minted & shielded',

    // Transfer stages
    [TRANSFER_STAGES.TRANSFER_PENDING]: 'Signing transfer',
    [TRANSFER_STAGES.TRANSFER_SUBMITTED]: 'Transfer submitted',
    [TRANSFER_STAGES.TRANSFER_CONFIRMED]: 'Transfer confirmed',

    // Unshield stages
    [UNSHIELD_STAGES.UNSHIELD_PENDING]: 'Signing unshield',
    [UNSHIELD_STAGES.UNSHIELD_SUBMITTED]: 'Unshield submitted',
    [UNSHIELD_STAGES.UNSHIELD_CONFIRMED]: 'Unshield confirmed',

    // Common/shared stages (proof_generating is shared between transfer & unshield)
    proof_generating: 'Generating proof',
    balance_updating: 'Updating balance',
    completed: 'Completed',
    failed: 'Failed',
  }

  return labels[stageId] || stageId
}

// ============ CCTP Metadata ============

/**
 * CCTP-specific metadata for cross-chain operations
 */
export interface CCTPMetadata {
  /** CCTP message nonce (bytes32 hex string, 0x-prefixed) */
  nonce?: string
  /** Source CCTP domain */
  sourceDomain?: number
  /** Destination CCTP domain */
  destinationDomain?: number
  /** Message hash for attestation lookup */
  messageHash?: string
  /** Attestation signature from Circle */
  attestation?: string
  /** Message bytes for relay */
  messageBytes?: string
}

// ============ Stored Transaction ============

/**
 * Complete transaction record stored in localStorage
 */
export interface StoredTransaction {
  /** Unique transaction ID */
  id: string

  /** Type of operation */
  flowType: FlowType

  /** Creation timestamp */
  createdAt: number

  /** Last update timestamp */
  updatedAt: number

  /** Overall transaction status */
  status: TxStatus

  /** Error message if failed */
  errorMessage?: string

  // ---- Amount and Token ----

  /** Human-readable amount (e.g., "100.50") */
  amount: string

  /** Amount in base units as string */
  amountRaw: string

  /** Token symbol (e.g., "USDC") */
  tokenSymbol: string

  // ---- Chain Information ----

  /** Source chain for the operation */
  sourceChain: ChainScope

  /** Destination chain (for cross-chain ops) */
  destinationChain?: ChainScope

  /** Whether this is a cross-chain operation */
  isCrossChain: boolean

  // ---- Addresses ----

  /** Public address (from for shield, to for unshield) */
  publicAddress?: string

  /** Railgun address (to for shield/transfer, from for unshield) */
  railgunAddress?: string

  /** Recipient address (for transfer/unshield) */
  recipientAddress?: string

  // ---- Transaction Hashes ----

  /** Transaction hashes by purpose */
  txHashes: {
    /** ERC20 approval tx */
    approval?: string
    /** Main operation tx (shield/transfer/unshield) */
    main?: string
    /** CCTP relay tx on destination chain */
    relay?: string
  }

  // ---- Stage Tracking ----

  /** All stages for this transaction */
  stages: TxStage[]

  /** Currently active stage ID */
  currentStageId?: string

  // ---- CCTP Data (for cross-chain) ----

  /** CCTP-specific metadata */
  cctp?: CCTPMetadata
}

// ============ Transaction Creation Helpers ============

/**
 * Create initial stages for a flow
 */
export function createInitialStages(
  flowType: FlowType,
  isCrossChain: boolean,
): TxStage[] {
  const expectedStageIds = getExpectedStages(flowType, isCrossChain)

  return expectedStageIds.map((id, index) => ({
    id,
    label: getStageLabel(id),
    status: index === 0 ? 'active' : 'pending',
  }))
}

/**
 * Generate a unique transaction ID
 */
export function generateTxId(): string {
  const timestamp = Date.now().toString(36)
  const random = Math.random().toString(36).substring(2, 8)
  return `tx_${timestamp}_${random}`
}

/**
 * Create a new transaction record
 */
export function createTransaction(
  params: Omit<StoredTransaction, 'id' | 'createdAt' | 'updatedAt' | 'stages'>,
): StoredTransaction {
  const now = Date.now()
  const stages = createInitialStages(params.flowType, params.isCrossChain)

  return {
    ...params,
    id: generateTxId(),
    createdAt: now,
    updatedAt: now,
    stages,
    currentStageId: stages[0]?.id,
  }
}

// ============ Stage Update Helpers ============

/**
 * Update a stage in a transaction
 */
export function updateStage(
  tx: StoredTransaction,
  stageId: string,
  updates: Partial<TxStage>,
): StoredTransaction {
  const updatedStages = tx.stages.map((stage) =>
    stage.id === stageId ? { ...stage, ...updates } : stage,
  )

  return {
    ...tx,
    stages: updatedStages,
    updatedAt: Date.now(),
  }
}

/**
 * Mark a stage as confirmed and move to next stage
 */
export function confirmStageAndAdvance(
  tx: StoredTransaction,
  stageId: string,
  metadata?: Partial<TxStage>,
): StoredTransaction {
  const stageIndex = tx.stages.findIndex((s) => s.id === stageId)
  if (stageIndex === -1) return tx

  const updatedStages = tx.stages.map((stage, index) => {
    if (index === stageIndex) {
      return {
        ...stage,
        ...metadata,
        status: 'confirmed' as StageStatus,
        timestamp: Date.now(),
      }
    }
    if (index === stageIndex + 1) {
      return { ...stage, status: 'active' as StageStatus }
    }
    return stage
  })

  const nextStage = updatedStages[stageIndex + 1]

  return {
    ...tx,
    stages: updatedStages,
    currentStageId: nextStage?.id,
    updatedAt: Date.now(),
  }
}

/**
 * Completed message for each stage type
 * Used when completing transactions to fix stale "waiting..." messages
 */
const COMPLETED_STAGE_MESSAGES: Record<string, string> = {
  // Shield stages
  approval_pending: 'Approval transaction confirmed',
  approval_confirmed: 'Approval confirmed',
  shield_pending: 'Shield signature received',
  shield_submitted: 'Shield transaction confirmed',
  shield_confirmed: 'Shield confirmed on-chain',
  balance_updating: 'Balance updated',
  // Transfer stages
  proof_generating: 'Proof generated',
  transfer_pending: 'Transfer signature received',
  transfer_submitted: 'Transfer transaction confirmed',
  transfer_confirmed: 'Transfer confirmed on-chain',
  // Unshield stages
  unshield_pending: 'Unshield signature received',
  unshield_submitted: 'Unshield transaction confirmed',
  unshield_confirmed: 'Unshield confirmed on-chain',
  // CCTP stages
  cctp_burn_pending: 'CCTP burn signature received',
  cctp_burn_submitted: 'CCTP burn confirmed',
  cctp_burn_confirmed: 'Burn confirmed',
  cctp_attestation_pending: 'Attestation received',
  cctp_attestation_received: 'Attestation confirmed',
  cctp_relay_pending: 'Relay completed',
  cctp_mint_confirmed: 'USDC minted',
  // Final stages
  completed: 'Transaction completed',
}

/**
 * Mark transaction as completed
 */
export function completeTransaction(tx: StoredTransaction): StoredTransaction {
  const now = Date.now()

  // Mark ALL stages as confirmed (except 'failed' which should be skipped)
  // Also fix stale "waiting..." messages with completion messages
  const updatedStages = tx.stages.map((stage) => {
    // Skip the 'failed' stage - it shouldn't be marked as confirmed on success
    if (stage.id === 'failed') {
      return stage
    }
    // Mark all other stages as confirmed if not already
    if (stage.status !== 'confirmed' && stage.status !== 'error') {
      const completedMessage = COMPLETED_STAGE_MESSAGES[stage.id]
      return {
        ...stage,
        status: 'confirmed' as StageStatus,
        timestamp: stage.timestamp || now,
        message: completedMessage || stage.message,
      }
    }
    // Also fix stale messages for already-confirmed stages
    if (stage.status === 'confirmed' && stage.message?.toLowerCase().includes('waiting')) {
      const completedMessage = COMPLETED_STAGE_MESSAGES[stage.id]
      if (completedMessage) {
        return {
          ...stage,
          message: completedMessage,
        }
      }
    }
    return stage
  })

  return {
    ...tx,
    status: 'success',
    stages: updatedStages,
    currentStageId: 'completed',
    updatedAt: now,
  }
}

/**
 * Mark transaction as failed
 */
export function failTransaction(
  tx: StoredTransaction,
  errorMessage: string,
  failedStageId?: string,
): StoredTransaction {
  const updatedStages = tx.stages.map((stage) => {
    if (stage.id === failedStageId) {
      return { ...stage, status: 'error' as StageStatus, message: errorMessage }
    }
    if (stage.id === 'failed') {
      return { ...stage, status: 'confirmed' as StageStatus, timestamp: Date.now() }
    }
    return stage
  })

  return {
    ...tx,
    status: 'error',
    errorMessage,
    stages: updatedStages,
    currentStageId: failedStageId || tx.currentStageId,
    updatedAt: Date.now(),
  }
}
