/**
 * Overlay component that dims and locks form during transaction.
 */

import { Lock } from 'lucide-react'
import { ProgressStepper, type TransactionPhase } from './ProgressStepper'
import { cn } from '@/lib/utils'

export interface FormLockOverlayProps {
  isLocked: boolean
  message?: string
  currentPhase?: TransactionPhase
  className?: string
}

export function FormLockOverlay({
  isLocked,
  message = 'Transaction in progress...',
  currentPhase,
  className,
}: FormLockOverlayProps) {
  if (!isLocked) {
    return null
  }

  return (
    <div
      className={cn(
        "absolute inset-0 z-10 flex items-center justify-center bg-background backdrop-blur-2xl rounded-lg",
        className
      )}
    >
      <div className="text-center space-y-4 w-full max-w-md px-4">
        <Lock className="h-8 w-8 text-muted-foreground mx-auto animate-pulse" />
        <p className="text-sm text-muted-foreground">{message}</p>
        {currentPhase && (
          <div className="flex justify-center">
            <ProgressStepper currentPhase={currentPhase} />
          </div>
        )}
      </div>
    </div>
  )
}

