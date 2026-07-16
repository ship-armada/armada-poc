/**
 * Timeline Stage Mapping
 * 
 * Defines the mapping between flow stages and timeline display stages.
 * Maps chain-level statuses to simplified timeline steps for visual display.
 */

import type { ChainKey, FlowType } from '@/shared/flowStages'
import type { ChainStatus } from '@/services/polling/types'

/**
 * Timeline step keys
 */
export type TimelineStepKey = 'source_confirmed' | 'bridged' | 'submitting_dest' | 'completed'

/**
 * Timeline step configuration
 */
export interface TimelineStepConfig {
  /** Internal key for this step */
  key: TimelineStepKey
  /** Display label for this step */
  label: string
  /** Chain associated with this step */
  chain: ChainKey
  /** Function to determine if this step is complete */
  isComplete: (chainStatus: ChainStatus | null) => boolean
  /** Function to determine if this step is in progress */
  isInProgress: (chainStatus: ChainStatus | null, currentChain: ChainKey | undefined) => boolean
  /** Function to determine if this step has an error */
  hasError: (chainStatus: ChainStatus | null) => boolean
  /** Function to determine if this step has timed out */
  hasTimeout: (chainStatus: ChainStatus | null) => boolean
  /** Function to determine if this step is cancelled */
  hasCancelled: (chainStatus: ChainStatus | null, flowStatus?: string, currentChain?: ChainKey) => boolean
  /** Function to get status message for this step */
  getStatusMessage: (chainDisplayName: string) => string
}

/**
 * Get timeline step configuration for a flow type
 */
export function getTimelineSteps(flowType: FlowType): TimelineStepConfig[] {
  if (flowType === 'deposit') {
    return [
      {
        key: 'source_confirmed',
        label: 'Source Burn',
        chain: 'evm',
        isComplete: (status) => status?.status === 'success',
        isInProgress: (status, currentChain) => 
          status?.status === 'pending' && currentChain === 'evm',
        hasError: (status) => 
          status?.status === 'tx_error' || status?.status === 'polling_error',
        hasTimeout: (status) => status?.status === 'polling_timeout',
        hasCancelled: (status, flowStatus, currentChain) => 
          status?.status === 'cancelled' || (flowStatus === 'cancelled' && currentChain === 'evm'),
        getStatusMessage: (chainDisplayName) => `CCTP burn submitted on ${chainDisplayName}`,
      },
      {
        key: 'bridged',
        label: 'Forwarding via Noble',
        chain: 'noble',
        isComplete: (status) => status?.status === 'success',
        isInProgress: (status, currentChain) => 
          status?.status === 'pending' && currentChain === 'noble',
        hasError: (status) => 
          status?.status === 'tx_error' || status?.status === 'polling_error',
        hasTimeout: (status) => status?.status === 'polling_timeout',
        hasCancelled: (status, flowStatus, currentChain) => 
          status?.status === 'cancelled' || (flowStatus === 'cancelled' && currentChain === 'noble'),
        getStatusMessage: () => 'Waiting for confirmation of IBC forwarding on Noble...',
      },
      {
        key: 'submitting_dest',
        label: 'Receiving on Namada',
        chain: 'namada',
        isComplete: (status) => status?.status === 'success',
        isInProgress: (status, currentChain) => 
          status?.status === 'pending' && currentChain === 'namada',
        hasError: (status) => 
          status?.status === 'tx_error' || status?.status === 'polling_error',
        hasTimeout: (status) => status?.status === 'polling_timeout',
        hasCancelled: (status, flowStatus, currentChain) => 
          status?.status === 'cancelled' || (flowStatus === 'cancelled' && currentChain === 'namada'),
        getStatusMessage: () => 'Waiting for confirmation of receipt on Namada...',
      },
      {
        key: 'completed',
        label: 'Completed',
        chain: 'namada', // Final chain for deposit
        isComplete: (status) => status?.status === 'success',
        isInProgress: () => false, // Completed step is never in progress
        hasError: (status) => 
          status?.status === 'tx_error' || status?.status === 'polling_error',
        hasTimeout: (status) => status?.status === 'polling_timeout',
        hasCancelled: (status, flowStatus) => 
          status?.status === 'cancelled' || flowStatus === 'cancelled',
        getStatusMessage: () => 'Funds confirmed on Namada',
      },
    ]
  } else {
    // Payment/Send flow
    return [
      {
        key: 'source_confirmed',
        label: 'Submitted on Namada',
        chain: 'namada',
        isComplete: (status) => status?.status === 'success',
        isInProgress: (status, currentChain) => 
          status?.status === 'pending' && currentChain === 'namada',
        hasError: (status) => 
          status?.status === 'tx_error' || status?.status === 'polling_error',
        hasTimeout: (status) => status?.status === 'polling_timeout',
        hasCancelled: (status, flowStatus, currentChain) => 
          status?.status === 'cancelled' || (flowStatus === 'cancelled' && currentChain === 'namada'),
        getStatusMessage: () => 'Shielded IBC transaction submitted on Namada',
      },
      {
        key: 'bridged',
        label: 'Orbiter Forwarding',
        chain: 'noble',
        isComplete: (status) => status?.status === 'success',
        isInProgress: (status, currentChain) => 
          status?.status === 'pending' && currentChain === 'noble',
        hasError: (status) => 
          status?.status === 'tx_error' || status?.status === 'polling_error',
        hasTimeout: (status) => status?.status === 'polling_timeout',
        hasCancelled: (status, flowStatus, currentChain) => 
          status?.status === 'cancelled' || (flowStatus === 'cancelled' && currentChain === 'noble'),
        getStatusMessage: () => 'Waiting for confirmation of forwarding on Noble...',
      },
      {
        key: 'submitting_dest',
        label: 'Receiving on Dest',
        chain: 'evm',
        isComplete: (status) => status?.status === 'success',
        isInProgress: (status, currentChain) => 
          status?.status === 'pending' && currentChain === 'evm',
        hasError: (status) => 
          status?.status === 'tx_error' || status?.status === 'polling_error',
        hasTimeout: (status) => status?.status === 'polling_timeout',
        hasCancelled: (status, flowStatus, currentChain) => 
          status?.status === 'cancelled' || (flowStatus === 'cancelled' && currentChain === 'evm'),
        getStatusMessage: (chainDisplayName) => `Waiting for confirmation of receipt on ${chainDisplayName}...`,
      },
      {
        key: 'completed',
        label: 'Completed',
        chain: 'evm', // Final chain for payment
        isComplete: (status) => status?.status === 'success',
        isInProgress: () => false, // Completed step is never in progress
        hasError: (status) => 
          status?.status === 'tx_error' || status?.status === 'polling_error',
        hasTimeout: (status) => status?.status === 'polling_timeout',
        hasCancelled: (status, flowStatus) => 
          status?.status === 'cancelled' || flowStatus === 'cancelled',
        getStatusMessage: (chainDisplayName) => `Funds confirmed on ${chainDisplayName}`,
      },
    ]
  }
}

/**
 * Get status message for current timeline step
 */
export function getStatusMessage(
  step: TimelineStepConfig,
  chainDisplayName: string
): string {
  return step.getStatusMessage(chainDisplayName)
}
