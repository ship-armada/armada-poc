// ABOUTME: Flow-modal chrome — header (logo/steps or simple back+title), close control, and animated content slot.
// ABOUTME: Ported from the armada-app design mockup.
import { useRef, type ReactNode, type Ref } from 'react'
import { ArrowLeftIcon, XMarkIcon } from '@heroicons/react/24/outline'
import { ArmadaLogo } from '@/design'
import { IconButton } from '@/design'
import { Steps } from '@/design'
import a11y from '@/design/styles/formA11y.module.css'
import { MODAL_EXIT_TIMING_VARS } from './modalExitMotion'
import styles from './ModalShell.module.css'

export const modalActionRowEnter = styles.actionRowEnter
export const modalStepShell = styles.stepShell
export const modalStepBodyEnter = styles.stepBodyEnter

export type ModalShellChrome = 'default' | 'simple'
export type ModalShellSurface = 'default' | 'immersive'

export interface ModalShellProps {
  steps: string[]
  currentStep: number
  status?: 'default' | 'confirmed' | 'error'
  flowLabel?: string
  hideStepCount?: boolean
  hideSteps?: boolean
  /** `simple` = back + centered title + ghost close (no logo/steps). Mobile keypad chrome. */
  chrome?: ModalShellChrome
  /** `immersive` = full-bleed brand gradient (mobile keypad processing). */
  surface?: ModalShellSurface
  /** Centered header title when `chrome="simple"`. */
  headerTitle?: string
  /** Replaces the centered title in `chrome="simple"` (e.g. Shield/Unshield tabs). */
  headerCenter?: ReactNode
  /** Back control for `chrome="simple"` (always shown when provided). */
  onBack?: () => void
  exiting?: boolean
  onClose: () => void
  closeButtonRef?: Ref<HTMLButtonElement>
  children: ReactNode
}

export function ModalShell({
  steps,
  currentStep,
  status = 'default',
  flowLabel = 'Deposit',
  hideStepCount = false,
  hideSteps = false,
  chrome = 'default',
  surface = 'default',
  headerTitle,
  headerCenter,
  onBack,
  exiting = false,
  onClose,
  closeButtonRef,
  children,
}: ModalShellProps) {
  const fallbackCloseRef = useRef<HTMLButtonElement>(null)
  const resolvedCloseRef = closeButtonRef ?? fallbackCloseRef
  const isSimple = chrome === 'simple'
  const isImmersive = surface === 'immersive'
  const headerClassName = [
    styles.header,
    (hideSteps || isSimple) && styles.headerNoSteps,
    isSimple && styles.headerSimple,
    isImmersive && styles.headerImmersive,
    exiting && styles.headerExit,
  ]
    .filter(Boolean)
    .join(' ')

  const shellClassName = [
    styles.shell,
    isSimple && styles.shellSimple,
    isImmersive && styles.shellImmersive,
  ]
    .filter(Boolean)
    .join(' ')
  const contentClassName = [
    styles.content,
    isSimple && styles.contentSimple,
    isImmersive && styles.contentImmersive,
    exiting && styles.contentExit,
  ]
    .filter(Boolean)
    .join(' ')
  const closeClassName = [isSimple && styles.closeGhost, isImmersive && styles.closeImmersive]
    .filter(Boolean)
    .join(' ')

  return (
    <div className={shellClassName} style={exiting ? MODAL_EXIT_TIMING_VARS : undefined}>
      <header className={headerClassName}>
        {isSimple ? (
          <>
            {onBack ? (
              <button type="button" className={styles.back} onClick={onBack} aria-label="Back">
                <ArrowLeftIcon className={styles.backIcon} strokeWidth={1.5} aria-hidden />
              </button>
            ) : (
              <span className={styles.headerSideSlot} aria-hidden />
            )}
            {headerCenter ? (
              <div className={styles.headerCenter}>{headerCenter}</div>
            ) : (
              <h1 className={isImmersive ? a11y.srOnly : styles.headerTitle}>
                {headerTitle !== undefined ? headerTitle : flowLabel}
              </h1>
            )}
            <IconButton
              ref={resolvedCloseRef}
              variant="frosted"
              size="md"
              className={closeClassName}
              icon={<XMarkIcon strokeWidth={1.5} aria-hidden />}
              aria-label="Close"
              onClick={onClose}
            />
          </>
        ) : (
          <>
            <div className={styles.logoSlot}>
              <ArmadaLogo variant="mark" markTone="white" className={styles.logo} />
            </div>
            {hideSteps ? null : (
              <div className={styles.stepsWrap}>
                <Steps
                  steps={steps}
                  currentStep={currentStep}
                  status={status}
                  flowLabel={status === 'confirmed' ? undefined : flowLabel}
                  hideStepCount={hideStepCount}
                />
              </div>
            )}
            <IconButton
              ref={resolvedCloseRef}
              variant="frosted"
              size="md"
              icon={<XMarkIcon strokeWidth={1.5} aria-hidden />}
              aria-label="Close"
              onClick={onClose}
            />
          </>
        )}
      </header>
      <div className={contentClassName}>{children}</div>
    </div>
  )
}
