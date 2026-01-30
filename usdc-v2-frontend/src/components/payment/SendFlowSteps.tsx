import { CheckCircle2 } from 'lucide-react'
import { cn } from '@/lib/utils'

interface SendFlowStepsProps {
  amountComplete: boolean
  recipientComplete: boolean
  destinationChainComplete: boolean
  activeStep: number
}

export function SendFlowSteps({
  amountComplete,
  recipientComplete,
  destinationChainComplete,
  activeStep,
}: SendFlowStepsProps) {
  const steps = [
    { number: 1, label: 'Amount', complete: amountComplete },
    { number: 2, label: 'Recipient', complete: recipientComplete },
    { number: 3, label: 'Destination chain', complete: destinationChainComplete },
    { number: 4, label: 'Fees & review', complete: false },
  ]

  return (
    <div className="flex flex-col gap-4">
      {steps.map((step) => {
        const isActive = activeStep === step.number
        const isComplete = step.complete

        return (
          <div key={step.number} className="flex items-center gap-3">
            <div
              className={cn(
                'flex h-8 w-8 items-center justify-center rounded-full border-2 text-sm font-medium transition-all',
                isComplete &&
                  'border-info bg-info text-info-foreground',
                isActive &&
                  !isComplete &&
                  'border-info bg-transparent text-info',
                !isActive &&
                  !isComplete &&
                  'border-muted-foreground/30 bg-transparent text-muted-foreground'
              )}
            >
              {isComplete ? (
                <CheckCircle2 className="h-4 w-4" />
              ) : (
                step.number
              )}
            </div>
            <span
              className={cn(
                'text-sm font-medium transition-colors',
                isActive && 'text-foreground',
                !isActive && 'text-muted-foreground'
              )}
            >
              {step.label}
            </span>
          </div>
        )
      })}
    </div>
  )
}

