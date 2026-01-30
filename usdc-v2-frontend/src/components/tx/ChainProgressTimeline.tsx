/**
 * Chain Progress Timeline Component
 * 
 * Displays a horizontal progress timeline showing key stages of a transaction flow.
 * Shows 4 steps: Source Confirmed, Bridged, Submitting Dest, Completed
 * with icons and status coloring based on success/error/timeout states.
 * Uses Framer Motion for smooth animated line fills and state transitions.
 */

import React from 'react'
import { Check, XCircle, Clock, Loader2, CheckCircle2, Radar, AlertCircle, Pause } from 'lucide-react'
import { motion } from 'framer-motion'
import type { StoredTransaction } from '@/services/tx/transactionStorageService'
import { getAllChainStatuses } from '@/services/polling/pollingStatusUtils'
import { getTimelineSteps, getStatusMessage } from '@/services/tx/timelineStageMapping'
import { RetryPollingButton } from '@/components/polling/RetryPollingButton'
import { cn } from '@/lib/utils'
import type { ChainKey } from '@/shared/flowStages'
import type { ChainStatus } from '@/services/polling/types'
import { getChainDisplayName } from '@/utils/chainUtils'
import type { EvmChainsFile } from '@/config/chains'

export interface ChainProgressTimelineProps {
  transaction: StoredTransaction
  evmChainsConfig?: EvmChainsFile | null
  className?: string
}

/**
 * Timeline step state type
 */
type StepState = 'completed' | 'in_progress' | 'pending' | 'error' | 'timeout' | 'cancelled'

/**
 * Determine step state based on chain status and previous steps
 */
function getStepState(
  stepIndex: number,
  step: ReturnType<typeof getTimelineSteps>[number],
  chainStatus: ReturnType<typeof getAllChainStatuses>[ChainKey],
  previousStepsComplete: boolean,
  currentChain: ChainKey | undefined,
  flowStatus?: string
): StepState {
  // Special handling for "completed" step - check flow status
  if (step.key === 'completed') {
    if (flowStatus === 'success') {
      return 'completed'
    }
    // For timeout or error, keep Completed step in pending state (grey)
    if (flowStatus === 'tx_error' || flowStatus === 'polling_error' || flowStatus === 'polling_timeout') {
      return 'pending'
    }
    // If all previous steps are complete but flow isn't finalized, show as in progress
    if (previousStepsComplete) {
      return 'in_progress'
    }
    return 'pending'
  }

  // If previous steps aren't complete, this step is pending
  if (!previousStepsComplete && stepIndex > 0) {
    return 'pending'
  }

  // Check for errors first
  if (step.hasError(chainStatus)) {
    return 'error'
  }

  // Check for cancelled (similar to timeout - shows on specific step)
  if (step.hasCancelled(chainStatus, flowStatus, currentChain)) {
    return 'cancelled'
  }

  // Check for timeout
  if (step.hasTimeout(chainStatus)) {
    return 'timeout'
  }

  // Check if complete
  if (step.isComplete(chainStatus)) {
    return 'completed'
  }

  // Check if in progress
  if (step.isInProgress(chainStatus, currentChain)) {
    return 'in_progress'
  }

  // If chain status exists but not complete, it's pending
  if (chainStatus) {
    return 'pending'
  }

  // No chain status yet
  return 'pending'
}

/**
 * Get chain logo URL
 */
function getChainLogo(
  chain: ChainKey,
  transaction: StoredTransaction,
  evmChainsConfig?: { chains: Array<{ key: string; name: string; logo?: string }> } | null
): string | undefined {
  if (chain === 'noble') {
    return '/assets/logos/noble-logo.svg'
  }
  if (chain === 'namada') {
    return '/assets/logos/namada-logo.svg'
  }
  // For EVM, get the logo from evmChainsConfig
  if (chain === 'evm') {
    const chainName = transaction.depositDetails?.chainName || transaction.paymentDetails?.chainName
    if (chainName && evmChainsConfig) {
      const foundChain = evmChainsConfig.chains.find(
        c => c.name.toLowerCase() === chainName.toLowerCase() || c.key === chainName
      )
      if (foundChain?.logo) {
        return foundChain.logo
      }
    }
    // Fallback: try to get from transaction.chain
    if (transaction.chain && evmChainsConfig) {
      const foundChain = evmChainsConfig.chains.find(
        c => c.key === transaction.chain || c.name.toLowerCase() === transaction.chain.toLowerCase()
      )
      if (foundChain?.logo) {
        return foundChain.logo
      }
    }
  }
  return undefined
}

/**
 * Get icon for step state
 */
function getStepIcon(
  state: StepState,
  stepIndex: number,
  chain: ChainKey,
  transaction: StoredTransaction,
  evmChainsConfig?: { chains: Array<{ key: string; name: string; logo?: string }> } | null
) {
  // For first 3 steps when completed, show chain logo instead of checkmark
  if (state === 'completed' && stepIndex < 3) {
    const logoUrl = getChainLogo(chain, transaction, evmChainsConfig)
    if (logoUrl) {
      return (
        <img
          src={logoUrl}
          alt={`${chain} logo`}
          className="h-10 w-10 object-contain"
          onError={(e) => {
            // Fallback to checkmark if logo fails to load
            e.currentTarget.style.display = 'none'
          }}
        />
      )
    }
    // Fallback to checkmark if no logo available
    return <Check className="h-4 w-4" />
  }

  switch (state) {
    case 'completed':
      return <Check className="h-4 w-4" />
    case 'error':
      return <XCircle className="h-4 w-4" />
    case 'timeout':
      return <Clock className="h-4 w-4" />
    case 'in_progress':
      return <Loader2 className="h-4 w-4 animate-spin" />
    case 'cancelled':
      return <Pause className="h-4 w-4" />
    case 'pending':
    default:
      return null
  }
}

/**
 * Status box state type
 */
type StatusBoxState = 'success' | 'tx_error' | 'polling_error' | 'polling_timeout' | 'cancelled' | 'in_progress' | 'user_action_required' | null

/**
 * Determine status box state based on transaction flow status and chain statuses
 */
function getStatusBoxState(
  transaction: StoredTransaction,
  stepStates: Array<{step: ReturnType<typeof getTimelineSteps>[number], state: StepState, chainStatus: ChainStatus | null}>
): StatusBoxState {
  const flowStatus = transaction.pollingState?.flowStatus
  
  // Check flow-level status first (polling cancellation takes precedence)
  if (flowStatus === 'success') return 'success'
  if (flowStatus === 'tx_error') return 'tx_error'
  if (flowStatus === 'polling_error') return 'polling_error'
  if (flowStatus === 'polling_timeout') return 'polling_timeout'
  if (flowStatus === 'user_action_required') return 'user_action_required'
  if (flowStatus === 'cancelled') return 'cancelled'
  
  // Check for transaction.errorMessage (transaction-level error)
  // Always treat as tx_error (red) unless flowStatus explicitly says cancelled
  if (transaction.errorMessage) {
    return 'tx_error'
  }
  
  // Check for in-progress states
  if (flowStatus === 'pending' || stepStates.some(s => s.state === 'in_progress')) {
    return 'in_progress'
  }
  
  // Check individual chain statuses for errors
  const chainStatuses = getAllChainStatuses(transaction)
  const hasUserActionRequired = Object.values(chainStatuses).some(
    cs => cs?.status === 'user_action_required'
  )
  const hasTxError = Object.values(chainStatuses).some(
    cs => cs?.status === 'tx_error'
  )
  const hasPollingError = Object.values(chainStatuses).some(
    cs => cs?.status === 'polling_error'
  )
  const hasPollingTimeout = Object.values(chainStatuses).some(
    cs => cs?.status === 'polling_timeout'
  )
  
  // user_action_required takes precedence over other error states
  if (hasUserActionRequired) return 'user_action_required'
  if (hasTxError) return 'tx_error'
  if (hasPollingError) return 'polling_error'
  if (hasPollingTimeout) return 'polling_timeout'
  
  return null
}

/**
 * Extract error message from transaction or chain statuses for tx_error display
 */
function getTxErrorMessage(transaction: StoredTransaction): string | undefined {
  // Prioritize transaction.errorMessage if it exists
  if (transaction.errorMessage) {
    // Sanitize the error message (remove common prefixes/suffixes)
    let message = transaction.errorMessage.trim()
    // Remove "Error:" prefix if present
    if (message.toLowerCase().startsWith('error:')) {
      message = message.substring(6).trim()
    }
    return message
  }
  
  // Fallback to chain status error messages
  const chainStatuses = getAllChainStatuses(transaction)
  for (const chainStatus of Object.values(chainStatuses)) {
    if (chainStatus?.status === 'tx_error' && chainStatus.errorMessage) {
      return chainStatus.errorMessage
    }
  }
  return undefined
}

/**
 * Get color classes for step state
 */
function getStepColorClasses(state: StepState): { 
  border: string
  background: string
  text: string
  icon: string
  line: string
} {
  switch (state) {
    case 'completed':
      return {
        border: 'border-none',
        background: 'bg-primary',
        text: 'text-foreground',
        icon: 'text-muted',
        line: 'bg-primary',
      }
    case 'error':
      return {
        border: 'border-error',
        background: 'bg-error',
        text: 'text-error',
        icon: 'text-white',
        line: 'bg-error',
      }
    case 'timeout':
      return {
        border: 'border-warning',
        background: 'bg-warning',
        text: 'text-warning',
        icon: 'text-white',
        line: 'bg-warning',
      }
    case 'cancelled':
      return {
        border: 'border-warning',
        background: 'bg-warning',
        text: 'text-warning',
        icon: 'text-white',
        line: 'bg-warning',
      }
    case 'in_progress':
      return {
        border: 'border-primary',
        background: 'bg-transparent',
        text: 'text-foreground',
        icon: 'text-primary',
        line: 'bg-primary',
      }
    case 'pending':
    default:
      return {
        border: 'border-muted-foreground',
        background: 'bg-transparent',
        text: 'text-muted-foreground',
        icon: 'text-muted-foreground',
        line: 'bg-muted',
      }
  }
}

export function ChainProgressTimeline({
  transaction,
  evmChainsConfig,
  className,
}: ChainProgressTimelineProps) {
  const flowType = transaction.direction === 'deposit' ? 'deposit' : 'payment'
  const flowTypeForMessages = transaction.direction === 'deposit' ? 'deposit' : 'send'
  const flowTypeCapitalized = transaction.direction === 'deposit' ? 'Deposit' : 'Send'
  const steps = getTimelineSteps(flowType)
  const chainStatuses = getAllChainStatuses(transaction)
  const currentChain = transaction.pollingState?.currentChain

  // Determine state for each step
  // If no pollingState but there's an errorMessage, assume failure on first stage
  const stepStates = transaction.pollingState 
    ? steps.map((step, index) => {
        const chainStatus = chainStatuses[step.chain]
        const previousStepsComplete = steps
          .slice(0, index)
          .every((prevStep) => {
            const prevChainStatus = chainStatuses[prevStep.chain]
            return prevStep.isComplete(prevChainStatus)
          })
        
        return {
          step,
          state: getStepState(
            index,
            step,
            chainStatus,
            previousStepsComplete,
            currentChain,
            transaction.pollingState?.flowStatus
          ),
          chainStatus,
        }
      })
    : transaction.errorMessage
      ? steps.map((step, index) => {
          // First step shows as error, rest are pending
          return {
            step,
            state: index === 0 ? 'error' : 'pending' as StepState,
            chainStatus: null,
          }
        })
      : []

  // Determine status box state
  const statusBoxState = getStatusBoxState(transaction, stepStates)
  
  // Find current active step for status message (for in_progress/pending states)
  const activeStepIndex = stepStates.findIndex(
    (s) => s.state === 'timeout' || s.state === 'error' || s.state === 'in_progress' || (s.state === 'pending' && s.step.key !== 'completed')
  )
  const activeStep = activeStepIndex >= 0 
    ? stepStates[activeStepIndex] 
    : (stepStates[stepStates.length - 1]?.state === 'completed' ? stepStates[stepStates.length - 1] : null)
  const activeChainDisplayName = activeStep
    ? getChainDisplayName(activeStep.step.chain, transaction, evmChainsConfig || null)
    : ''
  
  // Get status message and subheading based on status box state
  let statusSubheading = ''
  let statusMessage = 'Processing transaction...'
  
  if (statusBoxState === 'success') {
    statusSubheading = `${flowTypeCapitalized} completed successfully.`
    const completedStep = stepStates.find(s => s.step.key === 'completed')
    statusMessage = completedStep 
      ? getStatusMessage(completedStep.step, activeChainDisplayName)
      : 'Funds delivered successfully'
  } else if (statusBoxState === 'user_action_required') {
    statusSubheading = 'Action required to continue'
    statusMessage = 'Noble forwarding address registration is required to complete this transaction.'
  } else if (statusBoxState === 'tx_error') {
    statusSubheading = `${flowTypeCapitalized} not completed.`
    const errorMsg = getTxErrorMessage(transaction)
    statusMessage = errorMsg || 'Transaction failed'
  } else if (statusBoxState === 'cancelled') {
    statusSubheading = `Tracking was cancelled before we could determine the outcome`
    const errorMsg = getTxErrorMessage(transaction)
    if (errorMsg) {
      statusMessage = errorMsg
    } else {
      statusMessage = `Your funds are not at risk, but the status may be out of date. You can retry tracing from the beginning.`
    }
  } else if (statusBoxState === 'polling_error' || statusBoxState === 'polling_timeout') {
    statusSubheading = `We're having trouble tracking this ${flowTypeForMessages} in real time.`
    // Shared message for both polling_error and polling_timeout
    statusMessage = `Your funds are not at risk, but the status may be out of date. You can retry tracing from the beginning.`
  } else if (statusBoxState === 'in_progress' && activeStep) {
    statusMessage = getStatusMessage(activeStep.step, activeChainDisplayName)
  }

  // Build grid template columns: auto 1fr auto 1fr auto 1fr auto
  const gridTemplateColumns = stepStates.length > 0
    ? stepStates
        .flatMap((_, index) => {
          if (index === stepStates.length - 1) {
            return ['auto']
          }
          return ['auto', '1fr']
        })
        .join(' ')
    : ''

  return (
    <div className={cn('space-y-4', className)}>
      {/* Horizontal Progress Timeline */}
      {stepStates.length > 0 && (
        <div 
          className="grid items-center w-full px-20 py-4"
          style={{ gridTemplateColumns }}
        >
          {stepStates.flatMap((stepState, index) => {
          const isLast = index === stepStates.length - 1
          const colors = getStepColorClasses(stepState.state)
          const icon = getStepIcon(
            stepState.state,
            index,
            stepState.step.chain,
            transaction,
            evmChainsConfig
          )
          
          // Determine line fill percentage based on progress reaching this connector
          // Connectors should be filled if we've reached the next step (completed or in progress)
          const nextStepState = !isLast ? stepStates[index + 1]?.state : null
          const lineFillWidth = (nextStepState === 'completed' || nextStepState === 'in_progress') ? '100%' : '0%'

          // Determine if step circle should have filled background
          const hasFilledBackground = 
            stepState.state === 'completed' || 
            stepState.state === 'error' || 
            stepState.state === 'timeout' ||
            stepState.state === 'cancelled'

          // Check if this is a logo step (first 3 steps when completed) vs checkmark step (4th step)
          const isLogoStep = stepState.state === 'completed' && index < 3
          const isCheckmarkStep = stepState.state === 'completed' && index === 3
          
          // Add pulse animation for in_progress state
          const isActive = stepState.state === 'in_progress'

          const elements = [
            // Step
            <div key={`step-${stepState.step.key}`} className="flex flex-col w-10 items-center">
              {/* Step Circle */}
              <div
                className={cn(
                  'relative z-10 flex h-10 w-10 items-center justify-center rounded-full border-2 transition-all',
                  colors.border,
                  // Logo steps: transparent background with border
                  isLogoStep && 'bg-transparent',
                  // Checkmark step: filled background
                  isCheckmarkStep && colors.background,
                  // Error/timeout/cancelled: filled background
                  (stepState.state === 'error' || stepState.state === 'timeout' || stepState.state === 'cancelled') && colors.background,
                  // Pending/in-progress: transparent
                  !hasFilledBackground && 'bg-transparent',
                  // Add pulse animation for active step
                  isActive && 'animate-pulse'
                )}
              >
                {icon && (
                  // Check if icon is an img element (logo) - React elements have type property
                  React.isValidElement(icon) && icon.type === 'img' ? (
                    // Logo: render directly without color class
                    icon
                  ) : (
                    // Icon (checkmark, error, etc.): apply color class
                    <span className={cn(
                      colors.icon,
                      // Checkmark step gets muted color on filled background
                      isCheckmarkStep && 'text-muted'
                    )}>
                      {icon}
                    </span>
                  )
                )}
              </div>
              {/* Step Label */}
              <span
                className={cn(
                  'text-xs font-semibold mt-2 text-center whitespace-nowrap',
                  colors.text
                )}
              >
                {stepState.step.label}
              </span>
            </div>
          ]

          // Add connecting line if not last step
          if (!isLast) {
            elements.push(
              <div key={`line-${stepState.step.key}`} className="relative mx-2 mb-6 h-1 rounded bg-muted overflow-hidden">
                <motion.div
                  initial={{ width: 0 }}
                  animate={{ width: lineFillWidth }}
                  transition={{ duration: 0.6, ease: 'easeInOut' }}
                  className={cn('absolute left-0 top-0 h-full', colors.line)}
                />
              </div>
            )
          }

          return elements
          })}
        </div>
      )}

      {/* Status Message Box */}
      {(transaction.pollingState || transaction.errorMessage) && statusBoxState && (
        <div className={cn(
          'rounded-2xl p-4',
          statusBoxState === 'success' && 'bg-success/80',
          statusBoxState === 'tx_error' && 'bg-error/80',
          statusBoxState === 'cancelled' && 'bg-muted-foreground/80',
          (statusBoxState === 'polling_error' || statusBoxState === 'polling_timeout') && 'bg-warning/80',
          statusBoxState === 'user_action_required' && 'bg-warning/80',
          statusBoxState === 'in_progress' && 'bg-muted/50'
        )}>
          <div className="flex items-center gap-4">
            {/* Icon */}
            {statusBoxState === 'success' && (
              <CheckCircle2 className="h-6 w-6 text-success-foreground flex-shrink-0 mt-0.5" />
            )}
            {statusBoxState === 'tx_error' && (
              <XCircle className="h-6 w-6 text-error-foreground flex-shrink-0 mt-0.5" />
            )}
            {statusBoxState === 'cancelled' && (
              <Radar className="h-6 w-6 text-warning-foreground flex-shrink-0 mt-0.5" />
            )}
            {(statusBoxState === 'polling_error' || statusBoxState === 'polling_timeout') && (
              <Radar className="h-6 w-6 text-warning-foreground flex-shrink-0 mt-0.5" />
            )}
            {statusBoxState === 'user_action_required' && (
              <AlertCircle className="h-6 w-6 text-warning-foreground flex-shrink-0 mt-0.5" />
            )}
            {statusBoxState === 'in_progress' && (
              <Loader2 className="h-6 w-6 text-primary animate-spin flex-shrink-0 mt-0.5" />
            )}
            
            {/* Message and Button */}
            <div className="flex-1 flex items-center justify-between gap-4">
              <div className="flex-1">
                {/* Subheading */}
                {statusSubheading && (
                  <p className={cn(
                    'text-md font-medium mb-1',
                    statusBoxState === 'success' && 'text-success-foreground',
                    statusBoxState === 'tx_error' && 'text-error-foreground',
                    statusBoxState === 'cancelled' && 'text-warning-foreground',
                    (statusBoxState === 'polling_error' || statusBoxState === 'polling_timeout') && 'text-warning-foreground',
                    statusBoxState === 'user_action_required' && 'text-warning-foreground',
                    statusBoxState === 'in_progress' && 'text-foreground'
                  )}>
                    {statusSubheading}
                  </p>
                )}
                {/* Message content */}
                <span className={cn(
                  'text-sm',
                  statusBoxState === 'success' && 'text-success-foreground',
                  statusBoxState === 'tx_error' && 'text-error-foreground',
                  statusBoxState === 'cancelled' && 'text-warning-foreground',
                  (statusBoxState === 'polling_error' || statusBoxState === 'polling_timeout') && 'text-warning-foreground',
                  statusBoxState === 'user_action_required' && 'text-warning-foreground',
                  statusBoxState === 'in_progress' && 'text-foreground-foreground'
                )}>
                  {statusMessage}
                </span>
              </div>
              
              {/* Register button removed - Noble support disabled */}
              
              {/* Retry button for polling errors/timeouts/cancelled */}
              {(statusBoxState === 'polling_error' || statusBoxState === 'polling_timeout' || statusBoxState === 'cancelled') && (
                <RetryPollingButton 
                  transaction={transaction} 
                  size="md" 
                  variant="default"
                  className="flex-shrink-0"
                />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
