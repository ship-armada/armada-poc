// ABOUTME: Final confirmation screen — different copy + button row for first-time vs additional-commit (returning participant).
// ABOUTME: Ported from the armada-crowdfund mockup (ParticipateFlow/screens/Step5Confirmation.tsx); @armada/ui primitive imports rewritten to named imports from the package barrel.

import styles from './Step5Confirmation.module.css'
import { Steps } from '@armada/ui'
import { Button } from '@armada/ui'
import type { ParticipateStepBarProps } from '../participateFlowSteps'

interface Step5ConfirmationProps extends ParticipateStepBarProps {
  onInvite: () => void
  onViewPosition?: () => void
  /** Path 1 invite link — always show View your position beside Invite. */
  showViewPositionButton?: boolean
  amount?: number
  estimatedArm?: number
  /** User committed more USDC in a follow-up visit (not first participation). */
  isAdditionalCommit?: boolean
  totalCommittedUsdc?: number
  /** User was already at their maximum on entry — they didn't commit anything
   *  this visit. Swaps in "already fully committed" copy (no amount added). */
  maxedOut?: boolean
}

const DEFAULT_STEPS = ['Connect', 'Commit', 'Review', 'Confirmation']

function formatUsd(value: number) {
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })
}

export default function Step5Confirmation({
  onInvite,
  onViewPosition,
  showViewPositionButton = false,
  amount = 1000,
  estimatedArm = 1000,
  isAdditionalCommit = false,
  totalCommittedUsdc,
  maxedOut = false,
  steps = DEFAULT_STEPS,
  stepIndex = 4,
  stepsStatus = 'confirmed',
}: Step5ConfirmationProps) {
  const formattedAmount = formatUsd(amount)
  const totalCommitted = totalCommittedUsdc ?? estimatedArm
  const formattedTotal = formatUsd(totalCommitted)
  const shouldShowViewPosition =
    Boolean(onViewPosition) && (showViewPositionButton || isAdditionalCommit || maxedOut)

  const headline = maxedOut
    ? "You're fully committed."
    : isAdditionalCommit
      ? 'Commitment updated.'
      : "You're in."
  const subline = maxedOut ? (
    <>
      You've committed the maximum — {formattedTotal} USDC.
      <br />
      Up to {estimatedArm.toLocaleString()} ARM reserved for you.
    </>
  ) : isAdditionalCommit ? (
    <>
      {formattedAmount} added to your position.
      <br />
      {formattedTotal} USDC committed · up to {estimatedArm.toLocaleString()} ARM reserved.
    </>
  ) : (
    <>
      {formattedAmount} USDC committed.
      <br />
      Up to {estimatedArm.toLocaleString()} ARM reserved for you.
    </>
  )

  return (
    <div className={styles.shell}>
      <Steps steps={[...steps]} currentStep={stepIndex} status={stepsStatus} />

      <div className={styles.content}>
        <div className={styles.heroBlock}>
          <h1 className={styles.headline}>{headline}</h1>
          <p className={styles.subline}>{subline}</p>
        </div>

        <div className={styles.nextCard}>
          <span className={styles.nextEyebrow}>WHAT HAPPENS NEXT</span>
          <p className={styles.nextText}>
            {maxedOut
              ? 'Your ARM allocation is finalized when the commitment window closes. You can claim your tokens then.'
              : isAdditionalCommit
                ? 'Your updated allocation will be recalculated when the window closes. You can claim your tokens then.'
                : 'The commitment window stays open until it closes. Then your ARM allocation is calculated and you can claim your tokens.'}
          </p>
        </div>
      </div>

      <div className={styles.buttonRow}>
        {shouldShowViewPosition && onViewPosition && (
          <Button
            variant="secondary"
            size="lg"
            label="View your position"
            showIcon={false}
            onClick={onViewPosition}
          />
        )}
        <Button
          variant="primary"
          size="lg"
          label="Invite participants"
          showIcon={false}
          onClick={onInvite}
        />
      </div>
    </div>
  )
}
