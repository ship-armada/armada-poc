/**
 * Transaction Services
 *
 * Centralized exports for transaction storage, polling, and tracking.
 */

// Types
export type {
  StoredTransaction,
  TxStatus,
  TxStage,
  StageStatus,
  FlowType,
  ChainScope,
  CCTPMetadata,
  StageId,
  ShieldStageId,
  TransferStageId,
  UnshieldStageId,
} from '@/types/transaction'

export {
  SHIELD_STAGES,
  TRANSFER_STAGES,
  UNSHIELD_STAGES,
  getExpectedStages,
  getStageLabel,
  createTransaction,
  generateTxId,
  createInitialStages,
  updateStage,
  confirmStageAndAdvance,
  completeTransaction,
  failTransaction,
} from '@/types/transaction'

// Storage
export {
  saveTransaction,
  getTransaction,
  getAllTransactions,
  getTransactionsByStatus,
  getTransactionsByFlowType,
  getPendingTransactions,
  getCompletedTransactions,
  updateTransaction,
  deleteTransaction,
  clearAllTransactions,
  updateTxStage,
  confirmTxStage,
  completeTx,
  failTx,
  setMainTxHash,
  setApprovalTxHash,
  setRelayTxHash,
  updateCCTPMetadata,
  findByTxHash,
  getRecentTransactions,
  hasPendingTransactions,
  repairTransaction,
  repairAllTransactions,
  exportTransactions,
  importTransactions,
} from './privacyPoolTxStorage'

// Event Polling
export {
  PRIVACY_POOL_EVENTS,
  PRIVACY_POOL_CLIENT_EVENTS,
  CCTP_EVENTS,
  pollForEvents,
  pollTransactionReceipt,
  waitForTransaction,
  pollForShieldEvent,
  pollForUnshieldEvent,
  pollForCrossChainUnshieldEvent,
  pollForUnshieldReceivedEvent,
  getCurrentBlockNumber,
} from './privacyPoolEventPoller'

export type { EventMatch, PollOptions, PollResult } from './privacyPoolEventPoller'

// Shield Tracker
export {
  initShieldTransaction,
  markApprovalPending,
  markApprovalSubmitted,
  markApprovalConfirmed,
  markShieldPending,
  markShieldSubmitted,
  markShieldConfirmed,
  markBalanceUpdating as markShieldBalanceUpdating,
  markShieldCompleted,
  markShieldFailed,
  markCCTPBurnPending,
  markCCTPBurnSubmitted,
  markCCTPBurnConfirmed,
  markAttestationPending as markShieldAttestationPending,
  markAttestationReceived as markShieldAttestationReceived,
  markRelayPending as markShieldRelayPending,
  markCCTPMintConfirmed as markShieldCCTPMintConfirmed,
  waitForShieldConfirmation,
  waitForCCTPBurnConfirmation,
  trackCrossChainShieldCompletion,
} from './shieldTxTracker'

export type { ShieldTxParams, ShieldTxCallbacks } from './shieldTxTracker'

// Transfer Tracker
export {
  initTransferTransaction,
  markProofGenerating as markTransferProofGenerating,
  updateProofProgress as updateTransferProofProgress,
  markProofComplete as markTransferProofComplete,
  markTransferPending,
  markTransferSubmitted,
  markTransferConfirmed,
  markBalanceUpdating as markTransferBalanceUpdating,
  markTransferCompleted,
  markTransferFailed,
  waitForTransferConfirmation,
  trackTransferTransaction,
} from './transferTxTracker'

export type { TransferTxParams, TransferTxCallbacks } from './transferTxTracker'

// Unshield Tracker
export {
  initUnshieldTransaction,
  markProofGenerating as markUnshieldProofGenerating,
  updateProofProgress as updateUnshieldProofProgress,
  markProofComplete as markUnshieldProofComplete,
  markUnshieldPending,
  markUnshieldSubmitted,
  markUnshieldConfirmed,
  markBalanceUpdating as markUnshieldBalanceUpdating,
  markUnshieldCompleted,
  markUnshieldFailed,
  markCCTPAttestationPending,
  markCCTPAttestationReceived,
  markCCTPRelayPending,
  markCCTPMintConfirmed as markUnshieldCCTPMintConfirmed,
  waitForUnshieldConfirmation,
  waitForCrossChainUnshieldComplete,
  trackLocalUnshieldTransaction,
  trackCrossChainUnshieldTransaction,
} from './unshieldTxTracker'

export type { UnshieldTxParams, UnshieldTxCallbacks } from './unshieldTxTracker'
