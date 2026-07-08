// ABOUTME: Full-viewport deposit overlay — replaces ActionFlowShell/Modal for shield/unshield/send/earn flows.
// ABOUTME: Backdrop fades in first, then content; on close, content exits then backdrop.

import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { ArmadaSymbol } from '@armada/ui'
import { OVERLAY_EXIT_MS } from '@/constants/overlayMotion'
import { useOverlayExitTransition } from '@/hooks/useOverlayExitTransition'
import {
  FlowStepIndicator,
  type FlowStepIndicatorStatus,
} from '@/components/flow/FlowStepIndicator'
import { OVERLAY_STEP_LABELS } from '@/components/flow/overlayFlow'
import styles from './DepositOverlayShell.module.css'

export interface DepositOverlayShellProps {
  open: boolean
  /** Closes the flow (wired to the upper-right X). */
  onClose?: () => void
  /**
   * When false, hides the close control (e.g. wallet-confirmation progress).
   * Defaults to true when `onClose` is provided.
   */
  dismissible?: boolean
  /** Shown in the step indicator (e.g. Deposit, Withdraw, Send, Earn). */
  flowLabel?: string
  /** Dialog aria-label; defaults to flowLabel. */
  ariaLabel?: string
  /** 1-based step index for the 3-segment bar. */
  currentStep: number
  totalSteps?: number
  /** Lavender while in progress; green when the flow is confirmed. */
  status?: FlowStepIndicatorStatus
  children: ReactNode
}

export function DepositOverlayShell({
  open,
  onClose,
  dismissible: dismissibleProp,
  flowLabel = 'Deposit',
  ariaLabel,
  currentStep,
  totalSteps = OVERLAY_STEP_LABELS.length,
  status = 'default',
  children,
}: DepositOverlayShellProps) {
  const label = ariaLabel ?? flowLabel
  const dismissible = dismissibleProp ?? Boolean(onClose)
  const showCloseButton = dismissible && Boolean(onClose)
  const { mounted, exiting } = useOverlayExitTransition(open, OVERLAY_EXIT_MS)

  useEffect(() => {
    if (!mounted) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [mounted])

  useEffect(() => {
    if (!mounted || !showCloseButton || !onClose) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [mounted, showCloseButton, onClose])

  if (!mounted) return null

  return createPortal(
    <div
      className={styles.root}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      data-exiting={exiting ? true : undefined}
    >
      <div className={styles.backdrop} aria-hidden />
      <header className={styles.topBar}>
        <ArmadaSymbol className={styles.logo} size={48} />
        <div className={styles.stepHeader}>
          <FlowStepIndicator
            className={styles.stepIndicator}
            flowLabel={flowLabel}
            currentStep={currentStep}
            totalSteps={totalSteps}
            steps={[...OVERLAY_STEP_LABELS]}
            status={status}
          />
        </div>
        {showCloseButton ? (
          <button
            type="button"
            className={styles.closeButton}
            onClick={onClose}
            aria-label="Close"
          >
            <X size={24} aria-hidden="true" />
          </button>
        ) : (
          <span className={styles.closePlaceholder} aria-hidden />
        )}
      </header>
      <div className={styles.body}>
        <div className={styles.column}>{children}</div>
      </div>
    </div>,
    document.body,
  )
}

export { styles as depositOverlayShellStyles }
