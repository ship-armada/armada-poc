// ABOUTME: Ported byte-identical from the armada-crowdfund mockup (ParticipateFlow/screens/Step3Review.tsx).
// ABOUTME: Internal default imports of @armada/ui primitives (Steps, Tooltip, WalletItem) were rewritten to named imports from the package barrel.

import { Fragment } from 'react'
import styles from './Step3Review.module.css'
import { Steps } from '@armada/ui'
import { Button } from '@armada/ui'
import { Tooltip } from '@armada/ui'
import { InformationCircleIcon } from '@heroicons/react/24/solid'
import type { ParticipateStepBarProps } from '../participateFlowSteps'

/** Per-hop commit row for the multi-hop review variant. Triggers the
 *  multi-hop layout when `hopCommits.length > 1`. */
export interface Step3ReviewHopCommit {
  hop: 0 | 1 | 2
  /** Display label — e.g. 'SEED', 'HOP-1'. */
  hopLabel: string
  /** Dot color from the canonical hop palette (`graphHopColors.ts`). */
  hopColor: string
  /** Amount (USD) the user is committing at this hop in this flow. */
  amount: number
}

interface Step3ReviewProps extends ParticipateStepBarProps {
  onNext: () => void
  onBack: () => void
  /** Single-hop label (e.g. 'Hop 1'). Ignored when `hopCommits` is provided. */
  hopLevel?: string
  /** Single-hop committed amount (USD). Ignored when `hopCommits` is provided. */
  amount?: number
  estimatedArm?: number
  /** Per-hop commit breakdown for the multi-hop variant. When length > 1,
   *  replaces the single 'Hop level' / 'Committing' rows with a per-hop
   *  list + an aggregate total. */
  hopCommits?: ReadonlyArray<Step3ReviewHopCommit>
}

const DEFAULT_STEPS = ['Connect', 'Commit', 'Review', 'Confirmation']

function formatUsd(value: number): string {
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })
}

export default function Step3Review({
  onNext,
  onBack,
  hopLevel = 'Hop 1',
  amount = 1000,
  estimatedArm = 1000,
  steps = DEFAULT_STEPS,
  stepIndex = 3,
  hopCommits,
}: Step3ReviewProps) {
  const isMulti = !!hopCommits && hopCommits.length > 1
  const totalAmount = isMulti
    ? hopCommits!.reduce((sum, c) => sum + c.amount, 0)
    : amount
  const formattedTotal = formatUsd(totalAmount)

  return (
    <div className={[styles.shell, isMulti && styles.shellMultiHop].filter(Boolean).join(' ')}>
      <Steps steps={[...steps]} currentStep={stepIndex} />

      <div className={styles.content}>
        <h2 className={styles.title}>Review</h2>
        {/* Summary card. Multi-hop replaces the 'Hop level' / 'Committing'
            rows with one row per hop + an aggregate 'Total committing' row. */}
        <div className={styles.summaryCard}>
          {isMulti ? (
            <>
              {hopCommits!.map((c, i) => (
                // Fragment, not a wrapping `div`, so each `.summaryRow` is a
                // direct child of `.summaryCard` and the
                // `.summaryRow:first-child`/`:last-child` selectors that
                // strip top/bottom padding only fire on the literal first /
                // last row of the card.
                <Fragment key={c.hop}>
                  <div className={styles.summaryRow}>
                    <div className={styles.summaryLabelGroup}>
                      <span
                        className={styles.hopDot}
                        style={{ background: c.hopColor }}
                        aria-hidden
                      />
                      <span className={styles.summaryLabel}>{c.hopLabel}</span>
                    </div>
                    <span className={styles.summaryValue}>
                      {formatUsd(c.amount)} USDC
                    </span>
                  </div>
                  {i < hopCommits!.length - 1 && <div className={styles.divider} />}
                </Fragment>
              ))}
              <div className={styles.divider} />
              <div className={styles.summaryRow}>
                <span className={styles.summaryLabel}>Total committing</span>
                <span className={styles.summaryValue}>{formattedTotal} USDC</span>
              </div>
            </>
          ) : (
            <>
              <div className={styles.summaryRow}>
                <span className={styles.summaryLabel}>Hop level</span>
                <span className={styles.summaryValue}>{hopLevel}</span>
              </div>
              <div className={styles.divider} />
              <div className={styles.summaryRow}>
                <span className={styles.summaryLabel}>Committing</span>
                <span className={styles.summaryValue}>{formattedTotal} USDC</span>
              </div>
            </>
          )}
          <div className={styles.divider} />
          <div className={styles.summaryRow}>
            <div className={styles.summaryLabelGroup}>
              <span className={styles.summaryLabel}>EST. ARM allocation</span>
              <Tooltip
                variant="rich"
                title="EST. ARM Allocation"
                description={
                  isMulti
                    ? 'Estimated total ARM across every hop you are committing to.'
                    : 'Your estimated allocation based on the amount committed.'
                }
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
