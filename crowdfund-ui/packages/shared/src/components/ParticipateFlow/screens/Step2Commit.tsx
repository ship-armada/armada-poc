// ABOUTME: Step 2 of the Participate flow — USDC amount entry. Single-hop path keeps the designer's big centered input; multi-hop path stacks one input row per eligible hop with shared balance / allocation footer.
// ABOUTME: Ported from the armada-crowdfund mockup (ParticipateFlow/screens/Step2Commit.tsx); @armada/ui primitive imports rewritten to named imports from the package barrel. Multi-hop variant is local extension (designer-silent).

import { useEffect, useMemo, useState } from 'react'
import styles from './Step2Commit.module.css'
import { Steps } from '@armada/ui'
import { Button } from '@armada/ui'
import { Tooltip } from '@armada/ui'
import { InformationCircleIcon } from '@heroicons/react/24/solid'
import {
  hasActiveAmount,
  parseActiveAmount,
  sanitizeAmountInput,
} from '../../../lib/amountInput'
import type { ParticipateStepBarProps } from '../participateFlowSteps'

/** One per-hop input row for the multi-hop variant. The single-hop path is
 *  triggered when `hopRows` is omitted or length === 1 — passing a single
 *  row through is supported, but the legacy big-number input is preferred
 *  for that case (cleaner visual). */
export interface Step2CommitHopRow {
  hop: 0 | 1 | 2
  /** Display label — e.g. 'SEED', 'HOP-1', 'HOP-2'. */
  hopLabel: string
  /** Dot color from the canonical hop palette (`graphHopColors.ts`). */
  hopColor: string
  /** Per-hop cap in USDC (matches `effectiveCap` from useEligibility). */
  maxAmount: number
  /** Already committed at this hop, used to compute remaining cap. */
  existingCommittedUsdc: number
}

interface Step2CommitProps extends ParticipateStepBarProps {
  /** Single-hop callback. Called with the amount the user entered. Ignored
   *  when `hopRows` triggers the multi-hop path. */
  onNext: (amount: number) => void
  /** Multi-hop callback. Called instead of `onNext` when `hopRows.length > 1`.
   *  Map keyed by hop (0/1/2) with the per-hop amount the user entered. */
  onNextMulti?: (amounts: Record<0 | 1 | 2, number>) => void
  onBack: () => void
  maxAmount?: number
  availableBalance?: number
  maxArm?: number
  /** Already committed USDC — bar shows this before new input. */
  existingCommittedUsdc?: number
  showBack?: boolean
  /** Per-hop rows for the multi-hop variant. When length > 1, replaces the
   *  single amount input with stacked entries. Omit (or pass length ≤ 1) to
   *  keep the legacy designer-faithful single-hop UX. */
  hopRows?: ReadonlyArray<Step2CommitHopRow>
}

const DEFAULT_STEPS = ['Connect', 'Commit', 'Review', 'Confirmation']

function formatBalance(n: number) {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export default function Step2Commit({
  onNext,
  onNextMulti,
  onBack,
  maxAmount = 4000,
  availableBalance = 215154.14,
  maxArm = 4000,
  existingCommittedUsdc = 0,
  showBack = true,
  steps = DEFAULT_STEPS,
  stepIndex = 2,
  hopRows,
}: Step2CommitProps) {
  const isMulti = !!hopRows && hopRows.length > 1
  return isMulti ? (
    <MultiHopVariant
      hopRows={hopRows!}
      onNextMulti={onNextMulti}
      onBack={onBack}
      availableBalance={availableBalance}
      showBack={showBack}
      steps={steps}
      stepIndex={stepIndex}
    />
  ) : (
    <SingleHopVariant
      onNext={onNext}
      onBack={onBack}
      maxAmount={maxAmount}
      availableBalance={availableBalance}
      maxArm={maxArm}
      existingCommittedUsdc={existingCommittedUsdc}
      showBack={showBack}
      steps={steps}
      stepIndex={stepIndex}
    />
  )
}

// ── Single-hop variant (designer-faithful, byte-equivalent to original) ──

function SingleHopVariant({
  onNext,
  onBack,
  maxAmount,
  availableBalance,
  maxArm,
  existingCommittedUsdc,
  showBack,
  steps,
  stepIndex,
}: {
  onNext: (amount: number) => void
  onBack: () => void
  maxAmount: number
  availableBalance: number
  maxArm: number
  existingCommittedUsdc: number
  showBack: boolean
  steps: readonly string[]
  stepIndex: number
}) {
  // Free-form string state so the input can hold mid-decimal entries ("0.",
  // "1.") without flickering the bar / ARM allocation numbers. Parsed via
  // `parseActiveAmount` to a capped numeric for downstream math. Ported from
  // the armada-crowdfund mockup's Step2Commit (commit 214b972).
  const [amountInput, setAmountInput] = useState('')

  const remainingCap = Math.max(0, maxAmount - existingCommittedUsdc)
  const showActiveAmount = hasActiveAmount(amountInput)
  const amount = parseActiveAmount(amountInput, remainingCap)
  const existingRatio = Math.min(existingCommittedUsdc / maxAmount, 1)
  const newRatio = Math.min(amount / maxAmount, 1)
  const totalCommitted = existingCommittedUsdc + amount
  const totalArm = Math.round(totalCommitted)
  const hasNewAmount = amount > 0
  const hasExisting = existingCommittedUsdc > 0
  // Wallet-balance gate. `remainingCap` caps the typed input at the user's
  // *hop cap*, not their *wallet balance*; without this check a user with
  // $100 of USDC could enter $4,000 and click Review. Mirrors the
  // `overBalance` gate in `MultiHopVariant`.
  const overBalance = amount > availableBalance

  function handleInput(raw: string) {
    const next = sanitizeAmountInput(raw)
    if (!hasActiveAmount(next)) {
      setAmountInput('')
      return
    }
    // Trailing-dot entry: preserve the literal string while still capping the
    // integer part so the bar can't jump past `remainingCap`.
    if (next.endsWith('.')) {
      const val = parseFloat(next)
      if (!Number.isNaN(val) && val > remainingCap) {
        setAmountInput(String(remainingCap))
      } else {
        setAmountInput(next)
      }
      return
    }
    const val = parseFloat(next)
    if (Number.isNaN(val)) {
      setAmountInput('')
      return
    }
    const capped = Math.min(val, remainingCap)
    setAmountInput(hasActiveAmount(String(capped)) ? String(capped) : '')
  }

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
                  showActiveAmount ? styles.amountDisplayActive : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                aria-hidden="true"
              >
                {showActiveAmount ? amountInput : '0'}
              </span>
              <input
                id="commit-amount"
                type="text"
                inputMode="decimal"
                value={amountInput}
                onChange={(e) => handleInput(e.target.value)}
                className={styles.amountInput}
                aria-labelledby="commit-title"
                aria-describedby="commit-max commit-available"
              />
            </span>
          </label>

          <p className={styles.availableLabel} id="commit-available">
            Available {formatBalance(availableBalance)}
          </p>
          {overBalance && hasNewAmount && (
            <p className={styles.overBalance}>Amount exceeds your wallet balance.</p>
          )}
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
          disabled={!hasNewAmount || overBalance}
        />
      </div>
    </div>
  )
}

// ── Multi-hop variant (local extension; designer hasn't shipped a spec) ──

function MultiHopVariant({
  hopRows,
  onNextMulti,
  onBack,
  availableBalance,
  showBack,
  steps,
  stepIndex,
}: {
  hopRows: ReadonlyArray<Step2CommitHopRow>
  onNextMulti: ((amounts: Record<0 | 1 | 2, number>) => void) | undefined
  onBack: () => void
  availableBalance: number
  showBack: boolean
  steps: readonly string[]
  stepIndex: number
}) {
  // Amounts are tracked as strings so the user can clear a field without it
  // collapsing to "0" mid-typing. Numeric conversion happens for sums + the
  // submit callback.
  const [amounts, setAmounts] = useState<Record<0 | 1 | 2, string>>({
    0: '',
    1: '',
    2: '',
  })

  // Reset row state if the input set changes mid-flow (e.g. eligibility
  // refresh adds a new hop). Keyed on the hop list so re-mounting isn't
  // required for the common case where rows are stable.
  const hopsKey = useMemo(() => hopRows.map((r) => r.hop).join(','), [hopRows])
  useEffect(() => {
    setAmounts({ 0: '', 1: '', 2: '' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hopsKey])

  const parsedByHop = useMemo<Record<0 | 1 | 2, number>>(() => {
    const out: Record<0 | 1 | 2, number> = { 0: 0, 1: 0, 2: 0 }
    for (const row of hopRows) {
      const remaining = Math.max(0, row.maxAmount - row.existingCommittedUsdc)
      out[row.hop] = parseActiveAmount(amounts[row.hop], remaining)
    }
    return out
  }, [amounts, hopRows])

  const totalNew = useMemo(
    () => hopRows.reduce((sum, row) => sum + (parsedByHop[row.hop] ?? 0), 0),
    [parsedByHop, hopRows],
  )
  const totalExisting = useMemo(
    () => hopRows.reduce((sum, row) => sum + row.existingCommittedUsdc, 0),
    [hopRows],
  )
  const totalCap = useMemo(
    () => hopRows.reduce((sum, row) => sum + row.maxAmount, 0),
    [hopRows],
  )
  const totalArm = Math.round(totalExisting + totalNew)

  const overBalance = totalNew > availableBalance
  const anyOverHopCap = hopRows.some((row) => {
    const remaining = Math.max(0, row.maxAmount - row.existingCommittedUsdc)
    return parsedByHop[row.hop] > remaining
  })
  const canReview = totalNew > 0 && !overBalance && !anyOverHopCap

  const handleInputChange = (hop: 0 | 1 | 2, row: Step2CommitHopRow) =>
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const next = sanitizeAmountInput(e.target.value)
      const remaining = Math.max(0, row.maxAmount - row.existingCommittedUsdc)
      if (!hasActiveAmount(next)) {
        setAmounts((prev) => ({ ...prev, [hop]: '' }))
        return
      }
      // Trailing-dot mid-typing: preserve the literal string but cap the
      // integer portion so the per-row bar can't jump past `remaining`.
      if (next.endsWith('.')) {
        const val = parseFloat(next)
        if (!Number.isNaN(val) && val > remaining) {
          setAmounts((prev) => ({ ...prev, [hop]: String(remaining) }))
        } else {
          setAmounts((prev) => ({ ...prev, [hop]: next }))
        }
        return
      }
      const val = parseFloat(next)
      if (Number.isNaN(val)) {
        setAmounts((prev) => ({ ...prev, [hop]: '' }))
        return
      }
      const capped = Math.min(val, remaining)
      setAmounts((prev) => ({
        ...prev,
        [hop]: hasActiveAmount(String(capped)) ? String(capped) : '',
      }))
    }

  const handleNext = () => {
    if (!onNextMulti) return
    onNextMulti(parsedByHop)
  }

  // Bar fills: each hop contributes a slice proportional to its share of
  // totalCap. We render existing fills (purple-700) followed by new fills
  // (lavender) for each hop in declaration order.
  const safeTotalCap = totalCap > 0 ? totalCap : 1
  const existingRatio = Math.min(totalExisting / safeTotalCap, 1)
  const newRatio = Math.min((totalExisting + totalNew) / safeTotalCap, 1) - existingRatio

  return (
    <div className={styles.shell}>
      <Steps steps={[...steps]} currentStep={stepIndex} />

      <div className={styles.content}>
        <div className={styles.multiList}>
          <div>
            <h2 className={styles.multiTitle}>How much USDC?</h2>
            <p className={styles.multiAvailableLabel}>
              Available {formatBalance(availableBalance)}
            </p>
          </div>

          {hopRows.map((row) => {
            const remaining = Math.max(0, row.maxAmount - row.existingCommittedUsdc)
            const hasExisting = row.existingCommittedUsdc > 0
            const value = amounts[row.hop]
            const inputId = `commit-amount-hop-${row.hop}`
            return (
              <label key={row.hop} htmlFor={inputId} className={styles.multiRow}>
                <div className={styles.multiRowLeft}>
                  <span
                    className={styles.multiHopDot}
                    style={{ background: row.hopColor }}
                    aria-hidden
                  />
                  <span className={styles.multiHopLabel}>{row.hopLabel}</span>
                </div>
                <span className={styles.multiCapLabel}>
                  {hasExisting
                    ? `${remaining.toLocaleString()} remaining`
                    : `Max ${row.maxAmount.toLocaleString()}`}
                </span>
                <span className={styles.visuallyHidden}>
                  USDC amount for {row.hopLabel}
                </span>
                <input
                  id={inputId}
                  type="text"
                  inputMode="decimal"
                  value={value}
                  placeholder="0"
                  onChange={handleInputChange(row.hop, row)}
                  className={styles.multiAmountInput}
                />
              </label>
            )
          })}
        </div>

        <div className={styles.allocationBlock}>
          <div
            className={styles.barTrack}
            role="progressbar"
            aria-valuenow={Math.round((existingRatio + newRatio) * 100)}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Total committed amount progress"
          >
            {existingRatio > 0 && (
              <div
                className={styles.barFillExisting}
                style={{ width: `${existingRatio * 100}%` }}
              />
            )}
            {newRatio > 0 && (
              <div className={styles.barFillNew} style={{ width: `${newRatio * 100}%` }} />
            )}
          </div>
          <div className={styles.allocationRow}>
            <div className={styles.allocationLeft}>
              <span className={styles.allocationLabel}>EST. ARM ALLOCATION</span>
              <Tooltip
                variant="rich"
                title="EST. ARM Allocation"
                description="Estimated total ARM across all hops based on the amounts entered."
                bullets={[
                  '1 ARM per 1 USDC committed',
                  'Final allocation confirmed at close',
                  'Subject to per-hop pool caps',
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
                  totalNew > 0 || totalExisting > 0
                    ? styles.allocationValueActive
                    : styles.allocationValue
                }
              >
                {totalArm.toLocaleString()}
              </span>
              <span className={styles.allocationDivider} aria-hidden="true">
                /
              </span>
              <span className={styles.allocationMax}>{totalCap.toLocaleString()} ARM</span>
            </div>
          </div>
          {overBalance && (
            <p className={styles.overBalance}>
              Total exceeds your wallet balance.
            </p>
          )}
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
          onClick={handleNext}
          disabled={!canReview}
        />
      </div>
    </div>
  )
}
