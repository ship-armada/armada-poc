/**
 * Shared Flow Stages Model
 * 
 * Defines stage constants, chain order, and progression models for deposit and payment flows.
 * This is the single source of truth for flow stage definitions.
 * 
 * @module shared/flowStages
 */

/**
 * Flow types
 */
export type FlowType = 'deposit' | 'payment';

/**
 * Chain identifiers
 */
export type ChainKey = 'evm' | 'noble' | 'namada';

/**
 * Stage status values
 */
export type StageStatus = 'pending' | 'confirmed' | 'failed';

/**
 * Flow status values
 * 
 * Note: 'undetermined' is a flow-level status (not a stage) that indicates
 * the flow timed out without resolution. It's distinct from 'failed' which
 * indicates a known error. Both backend and frontend treat 'undetermined'
 * as a final state separate from 'completed' and 'failed'.
 */
export type FlowStatus = 'pending' | 'completed' | 'failed' | 'undetermined';

/**
 * Stage source
 */
export type StageSource = 'client' | 'poller';

/**
 * Deposit Flow Stages
 * 
 * Progression: EVM → Noble → Namada
 * 
 * Stages represent discrete events/milestones in the deposit flow:
 * - EVM: User burns USDC on EVM chain
 * - Noble: CCTP mints USDC on Noble, then forwards via IBC
 * - Namada: Receives USDC on Namada chain
 */
export const DEPOSIT_STAGES = {
  // EVM Chain Stages
  EVM_BURN_POLLING: 'evm_burn_polling',
  EVM_BURN_CONFIRMED: 'evm_burn_confirmed',
  
  // Iris Attestation Stages (replaces EVM polling)
  IRIS_ATTESTATION_POLLING: 'iris_attestation_polling',
  IRIS_ATTESTATION_COMPLETE: 'iris_attestation_complete',
  
  // Noble Chain Stages
  NOBLE_POLLING: 'noble_polling',
  NOBLE_CCTP_MINTED: 'noble_cctp_minted',
  NOBLE_FORWARDING_REGISTRATION: 'noble_forwarding_registration',
  NOBLE_IBC_FORWARDED: 'noble_ibc_forwarded',
  
  // Namada Chain Stages
  NAMADA_POLLING: 'namada_polling',
  NAMADA_RECEIVED: 'namada_received',
  
  // Flow Completion
  COMPLETED: 'completed',
  FAILED: 'failed',
} as const;

/**
 * Payment Flow Stages
 * 
 * Progression: Namada → Noble → EVM
 * 
 * Stages represent discrete events/milestones in the payment flow:
 * - Namada: User sends USDC via IBC from Namada
 * - Noble: Receives USDC on Noble, then burns via CCTP
 * - EVM: Mints USDC on EVM chain
 */
export const PAYMENT_STAGES = {
  // Namada Chain Stages
  NAMADA_IBC_SENT: 'namada_ibc_sent',  // TODO: Implement tracking
  
  // Noble Chain Stages
  NOBLE_POLLING: 'noble_polling',
  NOBLE_RECEIVED: 'noble_received',
  NOBLE_CCTP_BURNED: 'noble_cctp_burned',
  
  // EVM Chain Stages
  EVM_MINT_POLLING: 'evm_mint_polling',
  EVM_MINT_CONFIRMED: 'evm_mint_confirmed',
  
  // Flow Completion
  COMPLETED: 'completed',
  FAILED: 'failed',
} as const;

/**
 * All stage names as union types
 */
export type DepositStage = typeof DEPOSIT_STAGES[keyof typeof DEPOSIT_STAGES];
export type PaymentStage = typeof PAYMENT_STAGES[keyof typeof PAYMENT_STAGES];
export type FlowStage = DepositStage | PaymentStage;

/**
 * Chain Order Constants
 * 
 * Defines the order chains are processed in each flow type.
 */
export const CHAIN_ORDER = {
  DEPOSIT: ['evm', 'noble', 'namada'] as const satisfies readonly ChainKey[],
  PAYMENT: ['namada', 'noble', 'evm'] as const satisfies readonly ChainKey[],
} as const;

/**
 * Get chain order for flow type
 * 
 * @param flowType - The flow type ('deposit' or 'payment')
 * @returns Array of chain keys in processing order
 */
export function getChainOrder(flowType: FlowType): readonly ChainKey[] {
  return flowType === 'deposit' ? CHAIN_ORDER.DEPOSIT : CHAIN_ORDER.PAYMENT;
}

/**
 * Deposit Flow Progression Model
 * 
 * Defines expected stage progression for deposit flows, organized by chain.
 * Each chain has an ordered list of stages that should occur.
 */
export const DEPOSIT_PROGRESSION: Record<ChainKey, readonly DepositStage[]> = {
  evm: [
    DEPOSIT_STAGES.EVM_BURN_CONFIRMED,
    DEPOSIT_STAGES.IRIS_ATTESTATION_POLLING,
    DEPOSIT_STAGES.IRIS_ATTESTATION_COMPLETE,
  ],
  noble: [
    DEPOSIT_STAGES.NOBLE_POLLING,
    DEPOSIT_STAGES.NOBLE_CCTP_MINTED,
    DEPOSIT_STAGES.NOBLE_FORWARDING_REGISTRATION,
    DEPOSIT_STAGES.NOBLE_IBC_FORWARDED,
  ],
  namada: [
    DEPOSIT_STAGES.NAMADA_POLLING,
    DEPOSIT_STAGES.NAMADA_RECEIVED,
  ],
};

/**
 * Payment Flow Progression Model
 * 
 * Defines expected stage progression for payment flows, organized by chain.
 * Each chain has an ordered list of stages that should occur.
 */
export const PAYMENT_PROGRESSION: Record<ChainKey, readonly PaymentStage[]> = {
  namada: [
    PAYMENT_STAGES.NAMADA_IBC_SENT,
  ],
  noble: [
    PAYMENT_STAGES.NOBLE_POLLING,
    PAYMENT_STAGES.NOBLE_RECEIVED,
    PAYMENT_STAGES.NOBLE_CCTP_BURNED,
  ],
  evm: [
    PAYMENT_STAGES.EVM_MINT_POLLING,
    PAYMENT_STAGES.EVM_MINT_CONFIRMED,
  ],
};

/**
 * Get expected stages for a chain in a flow type
 * 
 * @param flowType - The flow type ('deposit' or 'payment')
 * @param chain - The chain identifier
 * @returns Array of expected stages for the chain in the flow type
 */
export function getExpectedStages(
  flowType: FlowType,
  chain: ChainKey
): readonly FlowStage[] {
  if (flowType === 'deposit') {
    return DEPOSIT_PROGRESSION[chain] ?? [];
  } else {
    return PAYMENT_PROGRESSION[chain] ?? [];
  }
}

/**
 * Validate stage name is valid for flow type and chain
 * 
 * @param stage - The stage name to validate
 * @param flowType - The flow type ('deposit' or 'payment')
 * @param chain - The chain identifier
 * @returns True if stage is valid for the flow type and chain
 */
export function isValidStage(
  stage: string,
  flowType: FlowType,
  chain: ChainKey
): boolean {
  const expectedStages = getExpectedStages(flowType, chain);
  return expectedStages.includes(stage as FlowStage);
}

/**
 * Get next expected stage in progression
 * 
 * @param currentStage - The current stage
 * @param flowType - The flow type ('deposit' or 'payment')
 * @param chain - The chain identifier
 * @returns The next expected stage, or null if current stage is last or invalid
 */
export function getNextStage(
  currentStage: FlowStage,
  flowType: FlowType,
  chain: ChainKey
): FlowStage | null {
  const expectedStages = getExpectedStages(flowType, chain);
  const currentIndex = expectedStages.indexOf(currentStage as FlowStage);
  
  if (currentIndex === -1 || currentIndex === expectedStages.length - 1) {
    return null;
  }
  
  return expectedStages[currentIndex + 1] as FlowStage;
}

/**
 * Check if stage indicates flow completion
 * 
 * @param stage - The stage to check
 * @returns True if stage indicates flow completion (completed or failed)
 */
export function isCompletionStage(stage: FlowStage): boolean {
  // Both DEPOSIT_STAGES and PAYMENT_STAGES have the same 'completed' and 'failed' values
  // Check against the literal strings to avoid TypeScript type narrowing issues
  return stage === 'completed' || stage === 'failed';
}

/**
 * Get chain for a given stage
 * 
 * @param stage - The stage name
 * @param flowType - The flow type ('deposit' or 'payment')
 * @returns The chain identifier for the stage, or null if not found
 */
export function getChainForStage(
  stage: FlowStage,
  flowType: FlowType
): ChainKey | null {
  const progression = flowType === 'deposit' 
    ? DEPOSIT_PROGRESSION 
    : PAYMENT_PROGRESSION;
  
  for (const [chain, stages] of Object.entries(progression)) {
    if (stages.includes(stage as any)) {
      return chain as ChainKey;
    }
  }
  
  return null;
}

/**
 * Get all stages for a flow type
 * 
 * @param flowType - The flow type ('deposit' or 'payment')
 * @returns Array of all stages for the flow type
 */
export function getAllStages(flowType: FlowType): readonly FlowStage[] {
  if (flowType === 'deposit') {
    return Object.values(DEPOSIT_STAGES) as readonly DepositStage[];
  } else {
    return Object.values(PAYMENT_STAGES) as readonly PaymentStage[];
  }
}

/**
 * Check if flow status is a final/terminal state
 * 
 * Final states are: 'completed', 'failed', 'undetermined'
 * These indicate the flow will not progress further.
 * 
 * @param status - The flow status to check
 * @returns True if status is a final state
 */
export function isFinalFlowStatus(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'undetermined';
}

/**
 * Check if flow status is 'undetermined' (timeout/unknown state)
 * 
 * 'undetermined' is distinct from 'failed':
 * - 'failed': Known error occurred
 * - 'undetermined': Flow timed out without resolution (unknown final state)
 * 
 * @param status - The flow status to check
 * @returns True if status is 'undetermined'
 */
export function isUndeterminedStatus(status: string): boolean {
  return status === 'undetermined';
}

