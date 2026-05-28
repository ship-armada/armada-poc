// ABOUTME: Ported byte-identical from the armada-crowdfund mockup (ParticipateFlow/screens/Step3Review.tsx).
// ABOUTME: Internal default imports of @armada/ui primitives (Steps, Tooltip, WalletItem) were rewritten to named imports from the package barrel.

import styles from './Step3Review.module.css'
import { Steps } from '@armada/ui'
import { Button } from '@armada/ui'
import { Tooltip } from '@armada/ui'
import { InformationCircleIcon } from '@heroicons/react/24/solid'
import type { ParticipateStepBarProps } from '../participateFlowSteps'

interface Step3ReviewProps extends ParticipateStepBarProps {
  onNext: () => void
  onBack: () => void
  hopLevel?: string
  amount?: number
  estimatedArm?: number
}

const DEFAULT_STEPS = ['Connect', 'Commit', 'Review', 'Confirmation']

export default function Step3Review({
  onNext,
  onBack,
  hopLevel = 'Hop 1',
  amount = 1000,
  estimatedArm = 1000,
  steps = DEFAULT_STEPS,
  stepIndex = 3,
}: Step3ReviewProps) {
  const formattedAmount = amount.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })

  return (
    <div className={styles.shell}>
      <Steps steps={[...steps]} currentStep={stepIndex} />

      <div className={styles.content}>
        <h2 className={styles.title}>Review</h2>
        {/* Summary card */}
        <div className={styles.summaryCard}>
          <div className={styles.summaryRow}>
            <span className={styles.summaryLabel}>Hop level</span>
            <span className={styles.summaryValue}>{hopLevel}</span>
          </div>
          <div className={styles.divider} />
          <div className={styles.summaryRow}>
            <span className={styles.summaryLabel}>Committing</span>
            <span className={styles.summaryValue}>{formattedAmount} USDC</span>
          </div>
          <div className={styles.divider} />
          <div className={styles.summaryRow}>
            <div className={styles.summaryLabelGroup}>
              <span className={styles.summaryLabel}>EST. ARM allocation</span>
              <Tooltip
                variant="rich"
                title="EST. ARM Allocation"
                description="Your estimated allocation based on the amount committed."
                bullets={[
                  '1 ARM per 1 USDC committed',
                  'Final allocation confirmed at close',
                  'Subject to pool cap',
                ]}
              >
                <button
                  type="button"
                  className={styles.infoTrigger}
                  aria-label="Estimated ARM allocation details"
                >
                  <InformationCircleIcon className={styles.infoIcon} aria-hidden />
                </button>
              </Tooltip>
            </div>
            <span className={styles.summaryValueAccent}>
              Up to {estimatedArm.toLocaleString()} ARM
            </span>
          </div>
        </div>

        {/* Warning block */}
        <div className={styles.warningBlock}>
          <p className={styles.warningText}>
            Commitments are final. You will not be able to withdraw during the 3-week window.
          </p>
        </div>
      </div>

      <div className={styles.buttonRow}>
        <Button
          variant="secondary"
          size="lg"
          label="Back"
          showIcon={false}
          onClick={onBack}
        />
        <Button
          variant="gradient"
          size="lg"
          label="Approve and commit"
          showIcon={false}
          onClick={onNext}
        />
      </div>
    </div>
  )
}
