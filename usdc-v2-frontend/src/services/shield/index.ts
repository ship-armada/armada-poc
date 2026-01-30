/**
 * Shield Services - Public API
 */

export {
  executeShieldTransaction,
  buildShieldRequest,
  validateShieldParams,
  getPublicUsdcBalance,
  getShieldAllowance,
  isApprovalNeeded,
  type ShieldTransactionParams,
  type ShieldTransactionDetails,
  type ShieldStage,
  type ShieldProgress,
} from './shieldService'

export {
  executeDirectShield,
  executeCrossChainShield,
  approveUsdcForShield,
  type ShieldContractParams,
  type ShieldResult,
} from './shieldContractService'

export {
  estimateShieldFee,
  formatFeeEstimate,
  type ShieldFeeEstimate,
} from './shieldFeeEstimatorService'
