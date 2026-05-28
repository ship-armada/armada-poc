// ABOUTME: Step 2 of the Participate flow — USDC amount entry with existing-commitment-aware progress bar + ARM allocation tooltip.
// ABOUTME: Ported from the armada-crowdfund mockup (ParticipateFlow/screens/Step2Commit.tsx); @armada/ui primitive imports rewritten to named imports from the package barrel.

import { useState } from 'react'
import styles from './Step2Commit.module.css'
import { Steps } from '@armada/ui'
import { Button } from '@armada/ui'
import { Tooltip } from '@armada/ui'
import { InformationCircleIcon } from '@heroicons/react/24/solid'
import type { ParticipateStepBarProps } from '../participateFlowSteps'
interface Step2CommitProps extends ParticipateStepBarProps {
  onNext: (amount: number) => void
  onBack: () => void
  maxAmount?: number
  availableBalance?: number
  maxArm?: number
  /** Already committed USDC — bar shows this before new input. */
  existingCommittedUsdc?: number
  showBack?: boolean
}

const DEFAULT_STEPS = ['Connect', 'Commit', 'Review', 'Confirmation']

export default function Step2Commit({
  onNext,
  onBack,
  maxAmount = 4000,
  availableBalance = 215154.14,
  maxArm = 4000,
  existingCommittedUsdc = 0,
  showBack = true,
  steps = DEFAULT_STEPS,
  stepIndex = 2,
}: Step2CommitProps) {
  const [amount, setAmount] = useState<number>(0)

  const remainingCap = Math.max(0, maxAmount - existingCommittedUsdc)
  const existingRatio = Math.min(existingCommittedUsdc / maxAmount, 1)
  const newRatio = Math.min(amount / maxAmount, 1)
  const totalCommitted = existingCommittedUsdc + amount
  const totalArm = Math.round(totalCommitted)
  const hasNewAmount = amount > 0
  const hasExisting = existingCommittedUsdc > 0

  const handleInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value.replace(/[^0-9.]/g, ''))
    if (isNaN(val)) {
      setAmount(0)
    } else {
      setAmount(Math.min(val, remainingCap))
    }
  }

  const formatBalance = (n: number) =>
    n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

  return (
    <div className={styles.shell}>
      <Steps steps={[...steps]} currentStep={stepIndex} />

      <div className={styles.content}>
        <div className={styles.inputBlock}>
          <div className={styles.titleBlock}>
            <h2 className={styles.title} id="commit-title">How much USDC?</h2>
            <p className={styles.maxLabel} id="commit-max">
              {hasExisting
                ? `${remainingCap.toLocaleString()} remaining · ${maxAmount.toLocaleString()} cap`
                : `Max ${maxAmount.toLocaleString()}`}
            </p>
          </div>

          <label className={styles.amountWrapper} htmlFor="commit-amount">
            <span className={styles.visuallyHidden}>Amount in USDC</span>
            <span className={styles.amountField}>
              <span
                className={[
                  styles.amountDisplay,
                  hasNewAmount ? styles.amountDisplayActive : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                aria-hidden="true"
              >
                {hasNewAmount ? amount.toLocaleString() : '0'}
              </span>
              <input
                id="commit-amount"
                type="number"
                min={0}
                max={remainingCap}
                value={amount === 0 ? '' : amount}
                onChange={handleInput}
                className={styles.amountInput}
                aria-labelledby="commit-title"
                aria-describedby="commit-max commit-available"
              />
            </span>
          </label>

          <p className={styles.availableLabel} id="commit-available">
            Available {formatBalance(availableBalance)}
          </p>
        </div>

        <div className={styles.allocationBlock}>
          <div
            className={styles.barTrack}
            role="progressbar"
            aria-valuenow={Math.round((existingRatio + newRatio) * 100)}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Committed amount progress"
          >
            {hasExisting && (
              <div
                className={styles.barFillExisting}
                style={{ width: `${existingRatio * 100}%` }}
              />
            )}
            {hasNewAmount && (
              <div className={styles.barFillNew} style={{ width: `${newRatio * 100}%` }} />
            )}
          </div>
          <div className={styles.allocationRow}>
            <div className={styles.allocationLeft}>
              <span className={styles.allocationLabel}>EST. ARM ALLOCATION</span>
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
            <div className={styles.allocationRight}>
              <span
                className={
                  hasNewAmount || hasExisting ? styles.allocationValueActive : styles.allocationValue
                }
              >
                {totalArm.toLocaleString()}
              </span>
              <span className={styles.allocationDivider} aria-hidden="true">
                /
              </span>
              <span className={styles.allocationMax}>{maxArm.toLocaleString()} ARM</span>
            </div>
          </div>
        </div>
      </div>

      <div className={styles.buttonRow}>
        {showBack && (
          <Button variant="secondary" size="lg" label="Back" showIcon={false} onClick={onBack} />
        )}
        <Button
          variant="primary"
          size="lg"
          label="Review"
          showIcon={false}
          onClick={() => onNext(amount)}
          disabled={!hasNewAmount}
        />
      </div>
    </div>
  )
}
