/**
 * Reusable progress stepper component for transaction flows.
 * Shows Build → Sign → Submit phases with visual completion states.
 * Uses Framer Motion for smooth animated line fills and state transitions.
 */

import { CheckCircle2 } from 'lucide-react'
import { motion } from 'framer-motion'
import { cn } from '@/lib/utils'

export type TransactionPhase = 'building' | 'signing' | 'submitting' | null

export interface ProgressStepperProps {
  currentPhase: TransactionPhase
  className?: string
  isMaspTransaction?: boolean
}

export function ProgressStepper({ currentPhase, className, isMaspTransaction = false }: ProgressStepperProps) {
  const phases: Array<'building' | 'signing' | 'submitting'> = ['building', 'signing', 'submitting']
  
  // Build grid template columns: auto 1fr auto 1fr auto
  const gridTemplateColumns = phases
    .flatMap((_, index) => {
      if (index === phases.length - 1) {
        return ['auto']
      }
      return ['auto', '1fr']
    })
    .join(' ')
  
  // Show MASP text when building phase is active and it's a MASP transaction
  const showMaspText = isMaspTransaction && currentPhase === 'building'
  
  return (
    <div className={cn("flex flex-col items-center w-full", className)}>
      <div 
        className="grid items-center w-full px-2 py-4"
        style={{ gridTemplateColumns }}
      >
        {phases.flatMap((phase, idx) => {
          const isActive = currentPhase === phase
          const phaseIndex = currentPhase ? phases.indexOf(currentPhase) : -1
          const isComplete = phaseIndex > idx
          const isLast = idx === phases.length - 1
          
          const elements = [
            // Step
            <div key={`step-${phase}`} className="flex flex-col items-center">
              <motion.div
                layout
                initial={{ scale: 0.9, opacity: 0.8 }}
                animate={{
                  scale: isActive ? 1.1 : 1,
                  opacity: 1,
                }}
                transition={{ duration: 0.3, ease: 'easeOut' }}
                className={cn(
                  "w-8 h-8 rounded-full flex items-center justify-center text-xs font-medium transition-colors",
                  isComplete && "bg-success text-foreground",
                  isActive && "bg-primary text-primary-foreground ring-2 ring-primary ring-offset-3 ring-offset-background",
                  !isActive && !isComplete && "bg-muted text-muted-foreground"
                )}
              >
                {isComplete ? <CheckCircle2 className="h-4 w-4" /> : idx + 1}
              </motion.div>
              <span className={cn(
                "text-xs mt-3 text-center",
                isActive && "font-medium text-foreground",
                !isActive && "text-muted-foreground"
              )}>
                {phase === 'building' && 'Build'}
                {phase === 'signing' && 'Sign'}
                {phase === 'submitting' && 'Submit'}
              </span>
            </div>
          ]
          
          // Add connecting line if not last step
          if (!isLast) {
            elements.push(
              <div key={`line-${phase}`} className="relative mx-2 h-0.5 bg-muted overflow-hidden rounded self-start mt-4">
                <motion.div
                  initial={{ width: 0 }}
                  animate={{ width: isComplete ? '100%' : '0%' }}
                  transition={{ duration: 0.6, ease: 'easeInOut' }}
                  className="absolute left-0 top-0 h-full bg-success"
                />
              </div>
            )
          }
          
          return elements
        })}
      </div>
      {showMaspText && (
        <p className="text-xs mt-4 text-center text-muted-foreground px-4">
          Generating MASP proof. This may take a couple minutes...
        </p>
      )}
    </div>
  )
}

