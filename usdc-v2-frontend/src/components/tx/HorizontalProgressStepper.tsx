/**
 * Horizontal Progress Stepper Component
 *
 * Displays a simplified horizontal progress timeline for Privacy Pool transactions.
 * Shows 3-4 key steps with animated line fills based on transaction progress.
 * Uses Framer Motion for smooth animations.
 */

import { Check, XCircle, Loader2 } from 'lucide-react'
import { motion } from 'framer-motion'
import type { StoredTransaction, FlowType } from '@/types/transaction'
import { cn } from '@/lib/utils'

// ============ Types ============

export interface StepDefinition {
  key: string
  label: string
}

export interface HorizontalProgressStepperProps {
  transaction: StoredTransaction
  className?: string
}

type StepState = 'completed' | 'in_progress' | 'pending' | 'error'

// ============ Step Mappings ============

/**
 * Get simplified steps based on flow type.
 * These are high-level steps that map to groups of detailed stages.
 */
function getStepsForFlowType(flowType: FlowType, isCrossChain: boolean): StepDefinition[] {
  switch (flowType) {
    case 'shield':
      if (isCrossChain) {
        return [
          { key: 'deposit', label: 'Deposit' },
          { key: 'bridge', label: 'Bridge' },
          { key: 'shield', label: 'Shield' },
          { key: 'complete', label: 'Complete' },
        ]
      }
      return [
        { key: 'deposit', label: 'Deposit' },
        { key: 'shield', label: 'Shield' },
        { key: 'complete', label: 'Complete' },
      ]
    case 'transfer':
      return [
        { key: 'prove', label: 'Prove' },
        { key: 'submit', label: 'Submit' },
        { key: 'complete', label: 'Complete' },
      ]
    case 'unshield':
      if (isCrossChain) {
        return [
          { key: 'prove', label: 'Prove' },
          { key: 'unshield', label: 'Unshield' },
          { key: 'bridge', label: 'Bridge' },
          { key: 'complete', label: 'Complete' },
        ]
      }
      return [
        { key: 'prove', label: 'Prove' },
        { key: 'unshield', label: 'Unshield' },
        { key: 'complete', label: 'Complete' },
      ]
    default:
      return [
        { key: 'start', label: 'Start' },
        { key: 'process', label: 'Process' },
        { key: 'complete', label: 'Complete' },
      ]
  }
}

/**
 * Map stage IDs to simplified step keys.
 * This determines which detailed stages contribute to which high-level step.
 */
function getStepKeyForStageId(stageId: string, flowType: FlowType): string {
  // Shield flow stage mappings
  if (flowType === 'shield') {
    if (stageId.includes('deposit') || stageId.includes('approve')) {
      return 'deposit'
    }
    if (stageId.includes('cctp') || stageId.includes('bridge') || stageId.includes('relay')) {
      return 'bridge'
    }
    if (stageId.includes('shield') || stageId.includes('scan')) {
      return 'shield'
    }
    return 'complete'
  }

  // Transfer flow stage mappings
  if (flowType === 'transfer') {
    if (stageId.includes('prove') || stageId.includes('proof') || stageId.includes('build')) {
      return 'prove'
    }
    if (stageId.includes('submit') || stageId.includes('broadcast') || stageId.includes('confirm')) {
      return 'submit'
    }
    return 'complete'
  }

  // Unshield flow stage mappings
  if (flowType === 'unshield') {
    if (stageId.includes('prove') || stageId.includes('proof') || stageId.includes('build')) {
      return 'prove'
    }
    if (stageId.includes('unshield') || stageId.includes('submit') || stageId.includes('broadcast')) {
      return 'unshield'
    }
    if (stageId.includes('cctp') || stageId.includes('bridge') || stageId.includes('relay')) {
      return 'bridge'
    }
    return 'complete'
  }

  return 'process'
}

/**
 * Determine the state of each step based on transaction stages.
 */
function getStepStates(
  transaction: StoredTransaction,
  steps: StepDefinition[]
): Map<string, StepState> {
  const stepStates = new Map<string, StepState>()
  const { stages, status, flowType } = transaction

  // Initialize all steps as pending
  for (const step of steps) {
    stepStates.set(step.key, 'pending')
  }

  // If transaction failed, find which step it failed at
  if (status === 'error' || status === 'cancelled') {
    const errorStage = stages.find((s) => s.status === 'error')
    if (errorStage) {
      const errorStepKey = getStepKeyForStageId(errorStage.id, flowType)
      let foundError = false
      for (const step of steps) {
        if (step.key === errorStepKey) {
          stepStates.set(step.key, 'error')
          foundError = true
        } else if (!foundError) {
          // Steps before the error are completed
          stepStates.set(step.key, 'completed')
        }
        // Steps after error remain pending
      }
      return stepStates
    }
  }

  // If transaction succeeded, all steps are completed
  if (status === 'success') {
    for (const step of steps) {
      stepStates.set(step.key, 'completed')
    }
    return stepStates
  }

  // Transaction is pending - determine progress based on stages
  // Group stages by their step key
  const stagesByStep = new Map<string, typeof stages>()
  for (const stage of stages) {
    const stepKey = getStepKeyForStageId(stage.id, flowType)
    const existing = stagesByStep.get(stepKey) || []
    existing.push(stage)
    stagesByStep.set(stepKey, existing)
  }

  // Determine state for each step
  let foundInProgress = false
  for (const step of steps) {
    if (foundInProgress) {
      // Steps after the in-progress step are pending
      stepStates.set(step.key, 'pending')
      continue
    }

    const stepStages = stagesByStep.get(step.key) || []

    // Check if all stages for this step are confirmed
    const allConfirmed =
      stepStages.length > 0 && stepStages.every((s) => s.status === 'confirmed')

    // Check if any stage is active or has an error
    const hasActive = stepStages.some((s) => s.status === 'active')
    const hasError = stepStages.some((s) => s.status === 'error')

    if (hasError) {
      stepStates.set(step.key, 'error')
      foundInProgress = true
    } else if (allConfirmed) {
      stepStates.set(step.key, 'completed')
    } else if (hasActive || stepStages.some((s) => s.status === 'pending')) {
      stepStates.set(step.key, 'in_progress')
      foundInProgress = true
    }
  }

  return stepStates
}

// ============ Styling Helpers ============

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
        border: 'border-primary',
        background: 'bg-primary',
        text: 'text-foreground',
        icon: 'text-primary-foreground',
        line: 'bg-primary',
      }
    case 'error':
      return {
        border: 'border-error',
        background: 'bg-error',
        text: 'text-error',
        icon: 'text-error-foreground',
        line: 'bg-error',
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
        border: 'border-muted-foreground/30',
        background: 'bg-transparent',
        text: 'text-muted-foreground',
        icon: 'text-muted-foreground',
        line: 'bg-muted',
      }
  }
}

function getStepIcon(state: StepState, stepIndex: number) {
  switch (state) {
    case 'completed':
      return <Check className="h-4 w-4" />
    case 'error':
      return <XCircle className="h-4 w-4" />
    case 'in_progress':
      return <Loader2 className="h-4 w-4 animate-spin" />
    case 'pending':
    default:
      return <span className="text-xs font-medium">{stepIndex + 1}</span>
  }
}

// ============ Main Component ============

export function HorizontalProgressStepper({
  transaction,
  className,
}: HorizontalProgressStepperProps) {
  const steps = getStepsForFlowType(transaction.flowType, transaction.isCrossChain)
  const stepStates = getStepStates(transaction, steps)

  // Build grid template columns: auto 1fr auto 1fr auto...
  const gridTemplateColumns = steps
    .flatMap((_, index) => {
      if (index === steps.length - 1) {
        return ['auto']
      }
      return ['auto', '1fr']
    })
    .join(' ')

  return (
    <div className={cn('w-full', className)}>
      <div
        className="grid items-center w-full px-8 py-4"
        style={{ gridTemplateColumns }}
      >
        {steps.flatMap((step, index) => {
          const isLast = index === steps.length - 1
          const state = stepStates.get(step.key) || 'pending'
          const colors = getStepColorClasses(state)
          const icon = getStepIcon(state, index)

          // Determine line fill based on next step's state
          const nextState = !isLast ? stepStates.get(steps[index + 1].key) : null
          const lineFillWidth =
            nextState === 'completed' || nextState === 'in_progress' || nextState === 'error'
              ? '100%'
              : '0%'

          const hasFilledBackground = state === 'completed' || state === 'error'
          const isActive = state === 'in_progress'

          const elements = [
            // Step circle and label
            <div key={`step-${step.key}`} className="flex flex-col items-center">
              <motion.div
                initial={{ scale: 0.9, opacity: 0.8 }}
                animate={{
                  scale: isActive ? 1.05 : 1,
                  opacity: 1,
                }}
                transition={{ duration: 0.3, ease: 'easeOut' }}
                className={cn(
                  'relative z-10 flex h-8 w-8 items-center justify-center rounded-full border-2 transition-colors',
                  colors.border,
                  hasFilledBackground && colors.background,
                  !hasFilledBackground && 'bg-background',
                  isActive && 'ring-2 ring-primary/30 ring-offset-2 ring-offset-background'
                )}
              >
                <span className={colors.icon}>{icon}</span>
              </motion.div>
              <span
                className={cn(
                  'text-xs font-medium mt-2 text-center whitespace-nowrap',
                  colors.text
                )}
              >
                {step.label}
              </span>
            </div>,
          ]

          // Add connecting line if not last step
          if (!isLast) {
            elements.push(
              <div
                key={`line-${step.key}`}
                className="relative mx-2 mb-6 h-0.5 rounded bg-muted overflow-hidden"
              >
                <motion.div
                  initial={{ width: 0 }}
                  animate={{ width: lineFillWidth }}
                  transition={{ duration: 0.5, ease: 'easeInOut' }}
                  className={cn('absolute left-0 top-0 h-full', colors.line)}
                />
              </div>
            )
          }

          return elements
        })}
      </div>
    </div>
  )
}
